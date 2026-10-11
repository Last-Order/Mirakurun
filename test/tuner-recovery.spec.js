"use strict";

const assert = require("assert");
const childProcess = require("child_process");
const http = require("http");
const { EventEmitter } = require("events");
const { PassThrough } = require("stream");
const express = require("express");
const shared = require("../lib/Mirakurun/_").default;
const Event = require("../lib/Mirakurun/Event").default;
const Tuner = require("../lib/Mirakurun/Tuner").default;
const api = require("../lib/Mirakurun/api");
const log = require("../lib/Mirakurun/log");
const Client = require("../lib/client").default;

const nextTurn = () => new Promise(resolve => setImmediate(resolve));

class Clock {
    constructor() {
        this.now = Date.now();
        this.timers = new Set();
        this.originals = [global.setTimeout, global.clearTimeout, Date.now];
        Date.now = () => this.now;
        global.setTimeout = (callback, delay, ...args) => {
            const timer = { at: this.now + delay, callback: () => callback(...args), unref() { return this; } };
            this.timers.add(timer);
            return timer;
        };
        global.clearTimeout = timer => this.timers.delete(timer);
    }

    async tick(delay) {
        const until = this.now + delay;
        await nextTurn();
        while (true) {
            const timer = [...this.timers].filter(item => item.at <= until).sort((a, b) => a.at - b.at)[0];
            if (!timer) break;
            this.now = timer.at;
            this.timers.delete(timer);
            timer.callback();
            await nextTurn();
        }
        this.now = until;
        await nextTurn();
    }

    restore() {
        [global.setTimeout, global.clearTimeout, Date.now] = this.originals;
    }
}

class Process extends EventEmitter {
    constructor(command, pid) {
        super();
        this.command = command;
        this.pid = pid;
        this.stdout = new PassThrough();
        this.stderr = new PassThrough();
        this.stdin = new PassThrough();
        this.stopCount = 0;
        this.stdin.on("data", chunk => {
            if (chunk.toString() === "\n") this.kill();
        });
    }

    kill() {
        this.stopCount++;
        if (!this.stopping) {
            this.stopping = true;
            setTimeout(() => this.finish(), 10);
        }
        return true;
    }

    finish() {
        this.emit("exit", 1, null);
        this.emit("close", 1, null);
    }
}

function packet(pid = 0x1fff) {
    const data = Buffer.alloc(188, 0xff);
    data.set([0x47, pid >> 8, pid & 0xff, 0x10]);
    return data;
}

describe("Tuner startup recovery", () => {
    let clock;
    let processes;
    let tuners;
    let servers;
    let requests;
    let originals;

    beforeEach(() => {
        originals = {
            spawn: childProcess.spawn,
            shared: { ...shared },
            config: { ...shared.config },
            log: Object.fromEntries(["debug", "info", "warn", "error", "fatal"].map(key => [key, log[key]]))
        };
        for (const key of Object.keys(originals.log)) log[key] = () => {};
        processes = [];
        tuners = [];
        servers = [];
        requests = [];
        clock = new Clock();
        childProcess.spawn = command => {
            const proc = new Process(command, 1000 + processes.length);
            processes.push(proc);
            return proc;
        };
        shared.config.server = {};
        shared.event = new Event();
        shared.program = { get: () => null };
        shared.service = { findByNetworkId: () => [] };
    });

    afterEach(async () => {
        for (const req of requests) req.destroy();
        for (const tuner of tuners) {
            for (const device of tuner.devices) {
                for (const user of [...device._users]) user._stream.close();
            }
        }
        for (const proc of processes) {
            proc.stderr.unpipe();
            proc.removeAllListeners();
            proc.stdout.destroy();
            proc.stderr.destroy();
            proc.stdin.destroy();
        }
        await nextTurn();
        await Promise.all(servers.map(server => new Promise(resolve => server.close(resolve))));
        clock.restore();
        childProcess.spawn = originals.spawn;
        Object.assign(log, originals.log);
        Object.assign(shared, originals.shared);
        for (const key of Object.keys(shared.config)) delete shared.config[key];
        Object.assign(shared.config, originals.config);
    });

    function setup(configs = [{}]) {
        shared.config.tuners = configs.map((options, i) => ({
            name: `tuner-${i}`, types: ["GR"], command: `tuner-${i} <channel>`, ...options
        }));
        const tuner = new Tuner();
        // Make the initial candidate order deterministic; production still shuffles.
        tuner._getDevicesByType = () => tuner.devices.slice();
        shared.tuner = tuner;
        tuners.push(tuner);
        const channel = {
            type: "GR", channel: "12", getServices: () => [{ networkId: 1 }],
            getStream: (user, dest) => tuner.initChannelStream(channel, user, dest)
        };
        const service = {
            networkId: 1, serviceId: 2, channel,
            getStream: (user, dest) => tuner.initServiceStream(service, user, dest)
        };
        const program = { id: 10000200003, networkId: 1, serviceId: 2, eventId: 3 };
        shared.channel = { get: () => channel };
        shared.service = { get: () => service, findByNetworkId: () => [] };
        return { tuner, channel, program };
    }

    function recording(tuner, channel, onError = () => {}) {
        const dest = new PassThrough();
        dest.resume();
        return tuner.initChannelStream(channel, { id: "recording", priority: 0, disableDecoder: true, onError }, dest);
    }

    async function httpRequest(handler, decode = false, useClient = false) {
        const app = express();
        let initialized;
        const ready = new Promise(resolve => initialized = resolve);
        app.get("/stream", (req, res) => {
            req.params = { id: 10000200003, type: "GR", channel: "12" };
            req.query.decode = decode ? 1 : 0;
            handler(req, res);
            initialized();
        });
        const server = http.createServer(app);
        servers.push(server);
        await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
        let result;
        if (useClient) {
            const client = new Client();
            client.host = "127.0.0.1";
            client.port = server.address().port;
            client.basePath = "";
            client.agent = false;
            result = client._requestStream("GET", "/stream").then(() => null, err => err);
        } else {
            result = new Promise((resolve, reject) => {
                const req = http.get({ host: "127.0.0.1", port: server.address().port, path: "/stream", agent: false }, res => {
                    const chunks = [];
                    res.on("data", chunk => chunks.push(chunk));
                    res.on("end", () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString() }));
                });
                requests.push(req);
                req.on("error", reject);
            });
        }
        await Promise.race([ready, result.then(error => assert.fail(`Request failed before initialization: ${error}`))]);
        await nextTurn();
        assert(shared.tuner.devices.some(device => device.users.some(user => user.url === "/stream")),
            "HTTP request should initialize a tuner stream");
        return { result, port: server.address().port };
    }

    it("releases an EPG-owned silent process and sends every shared user one failure", async () => {
        const { tuner, channel } = setup([{}, {}]);
        const epgError = tuner.getEPG(channel).then(() => null, err => err);
        await nextTurn();
        const failures = [];
        const first = await recording(tuner, channel, err => failures.push(err));
        const second = await recording(tuner, channel, err => failures.push(err));
        assert.strictEqual(processes.length, 1);
        assert.strictEqual(tuner.get(0).users.length, 3);
        await clock.tick(5000);
        assert.strictEqual((await epgError).code, "TUNER_STARTUP_FAILED");
        assert.strictEqual(first.closed, true);
        assert.strictEqual(second.closed, true);
        assert.strictEqual(failures.length, 2);
        assert(failures.every(err => err.code === "TUNER_STARTUP_FAILED"));
        assert.strictEqual(tuner.get(0).users.length, 0);
        assert.strictEqual(tuner.get(0).isAvailable, false);
        assert.strictEqual(processes[0].stopCount, 1);
        // A retry arriving before the old process has exited must select another device.
        await recording(tuner, channel);
        assert.strictEqual(processes[1].command, "tuner-1");
        processes[1].stdout.write(packet());
        await clock.tick(200);
        assert.strictEqual(tuner.get(0).isFree, true);
        assert.strictEqual(tuner.get(0).isCoolingDown, true);
        await clock.tick(60000);
        assert.strictEqual(processes.length, 2, "failed EPG must not respawn automatically");
    });

    it("prefers a healthy free tuner even when the failed tuner has been released", async () => {
        const { tuner, channel } = setup([{}, {}]);
        await recording(tuner, channel);
        await clock.tick(5200);
        assert.strictEqual(tuner.get(0).isFree, true);
        await recording(tuner, channel);
        assert.strictEqual(processes[1].command, "tuner-1");
    });

    it("can retry the only available tuner with a new process and clears cooldown on data", async () => {
        const { tuner, channel } = setup();
        await recording(tuner, channel);
        await clock.tick(5200);
        await recording(tuner, channel);
        assert.strictEqual(processes.length, 2);
        assert.notStrictEqual(processes[0].pid, processes[1].pid);
        processes[1].stdout.write(packet());
        await nextTurn();
        assert.strictEqual(tuner.get(0).isCoolingDown, false);
        assert.strictEqual(tuner.get(0).retryAfter, 0);
        await recording(tuner, channel);
        assert.strictEqual(processes.length, 2, "healthy same-channel users still share");
        assert.strictEqual(tuner.get(0).users.length, 2);
    });

    it("does not kill a recording that received raw TS while waiting for its event", async () => {
        const { tuner, channel, program } = setup();
        const dest = new PassThrough();
        let outputBytes = 0;
        const failures = [];
        dest.on("data", chunk => outputBytes += chunk.length);
        const filter = await tuner.initProgramStream(program, {
            id: "event-recording", priority: 0, disableDecoder: true, onError: err => failures.push(err)
        }, dest);
        processes[0].stdout.write(packet());
        await clock.tick(15000);
        assert.strictEqual(outputBytes, 0);
        assert.strictEqual(filter.closed, false);
        assert.strictEqual(processes[0].stopCount, 0);
        assert.deepStrictEqual(failures, []);
        await recording(tuner, channel);
        assert.strictEqual(processes.length, 1);
        assert.strictEqual(tuner.get(0).users.length, 2);
    });

    it("continues delivering TS to all healthy same-channel streams", async () => {
        const { tuner, channel } = setup();
        const outputs = [new PassThrough(), new PassThrough()];
        const bytes = [0, 0];
        for (let i = 0; i < outputs.length; i++) {
            outputs[i].on("data", chunk => bytes[i] += chunk.length);
            await tuner.initChannelStream(channel, { id: `user-${i}`, priority: 0, disableDecoder: true }, outputs[i]);
        }
        processes[0].stdout.write(packet(0x100));
        await clock.tick(15000);
        assert.deepStrictEqual(bytes, [188, 188]);
        assert.strictEqual(processes.length, 1);
        assert.strictEqual(processes[0].stopCount, 0);
    });

    it("honors startupTimeout and can disable the cooldown preference", async () => {
        const { tuner, channel } = setup([{ startupTimeout: 12000, retryCooldown: 0 }]);
        const filter = await recording(tuner, channel);
        await clock.tick(11999);
        assert.strictEqual(filter.closed, false);
        await clock.tick(1);
        assert.strictEqual(filter.closed, true);
        assert.strictEqual(tuner.get(0).isCoolingDown, false);
    });

    for (const reason of ["early exit", "spawn error"]) {
        it(`fails promptly on ${reason} before any TS arrives`, async () => {
            const { tuner, channel } = setup();
            const failures = [];
            const filter = await recording(tuner, channel, err => failures.push(err));
            if (reason === "early exit") {
                processes[0].finish();
            } else {
                processes[0].pid = undefined;
                processes[0].emit("error", Object.assign(new Error("not found"), { code: "ENOENT" }));
                setTimeout(() => processes[0].emit("close", -2, null), 10);
            }
            assert.strictEqual(filter.closed, true);
            assert.strictEqual(failures.length, 1);
            assert.strictEqual(failures[0].code, "TUNER_STARTUP_FAILED");
            await clock.tick(reason === "spawn error" ? 100 : 200);
            assert.strictEqual(tuner.get(0).isFree, true);
            await recording(tuner, channel);
            processes[1].stdout.write(packet());
            await clock.tick(5000);
            assert.strictEqual(tuner.get(0).pid, processes[1].pid);
            assert.strictEqual(tuner.get(0).isAvailable, true);
        });
    }

    it("reports startup failure to service scanning and stops its wait", async () => {
        const { tuner, channel } = setup();
        const result = tuner.getServices(channel).then(() => null, err => err);
        await clock.tick(5000);
        assert.strictEqual((await result).code, "TUNER_STARTUP_FAILED");
        assert.strictEqual(tuner.get(0).users.length, 0);
    });

    it("rejects EPG and scanning if failure closed the filter before initialization resolved", async () => {
        const { tuner, channel } = setup();
        const error = Object.assign(new Error("startup failed"), { code: "TUNER_STARTUP_FAILED" });
        tuner._initTS = async user => {
            user.onError(error);
            return { closed: true };
        };
        await assert.rejects(tuner.getEPG(channel), err => err === error);
        await assert.rejects(tuner.getServices(channel), err => err === error);
    });

    for (const decode of [false, true]) {
        it(`returns HTTP 503 for silent programme recording (decode=${decode})`, async () => {
            const { tuner, channel, program } = setup([{ decoder: "decoder" }]);
            shared.program.get = id => Number(id) === program.id ? program : null;
            const epgError = tuner.getEPG(channel).then(() => null, err => err);
            await nextTurn();
            const handler = require("../lib/Mirakurun/api/programs/{id}/stream").get;
            const { result } = await httpRequest(handler, decode, true);
            assert.strictEqual(tuner.get(0).users.length, 2);
            await clock.tick(5000);
            assert.match((await result).message, /503 Tuner Startup Failed/);
            assert.strictEqual((await epgError).code, "TUNER_STARTUP_FAILED");
            assert.strictEqual(tuner.get(0).users.length, 0);
        });
    }

    for (const route of ["services/{id}", "channels/{type}/{channel}"]) {
        it(`returns HTTP 503 for a silent ${route} stream`, async () => {
            setup();
            const handler = require(`../lib/Mirakurun/api/${route}/stream`).get;
            const { result } = await httpRequest(handler);
            await clock.tick(5000);
            const response = await result;
            assert.strictEqual(response.status, 503);
            assert.strictEqual(JSON.parse(response.body).reason, "Tuner Startup Failed");
        });
    }

    it("does not write a second response after a stream error has been handled", () => {
        const err = Object.assign(new Error("startup failed"), { code: "TUNER_STARTUP_FAILED" });
        const ended = { writableEnded: true, writeHead: () => assert.fail("already ended") };
        api.responseStreamErrorHandler(ended, err);
        const aborted = { destroyed: true, writeHead: () => assert.fail("already destroyed") };
        api.responseStreamErrorHandler(aborted, err);
        let destroyedWith;
        api.responseStreamErrorHandler({ headersSent: true, destroy: error => destroyedWith = error }, err);
        assert.strictEqual(destroyedWith, err);
    });
});
