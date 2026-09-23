"use strict";

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");
const { createDailyLogs } = require("../bin/daily-logs");

describe("Windows daily logs", () => {
    let directory;
    beforeEach(() => { directory = fs.mkdtempSync(path.join(os.tmpdir(), "mirakurun-logs-")); });
    afterEach(() => { fs.rmSync(directory, { recursive: true, force: true }); });

    it("appends across restarts and changes file at local midnight", () => {
        let clock = new Date(2026, 11, 31, 23, 59, 59);
        const options = { directory, now: () => clock };
        createDailyLogs(options).write("stdout", "first\n");
        const logger = createDailyLogs(options);
        logger.write("stdout", "second\n");
        clock = new Date(2027, 0, 1);
        logger.write("stdout", "third\n");
        logger.write("stderr", "error\n");
        assert.strictEqual(fs.readFileSync(path.join(directory, "stdout.2026-12-31.log"), "utf8"), "first\nsecond\n");
        assert.strictEqual(fs.readFileSync(path.join(directory, "stdout.2027-01-01.log"), "utf8"), "third\n");
        assert.strictEqual(fs.readFileSync(path.join(directory, "stderr.2027-01-01.log"), "utf8"), "error\n");
    });

    it("keeps today and six previous dates, cleans after downtime, preserves unrelated files", () => {
        const names = ["stdout.2026-12-25.log", "stderr.2026-12-26.log", "stdout.2026-12-27.log",
            "stderr.2027-01-01.log", "stdout", "notes.txt", "other.2020-01-01.log"];
        for (const name of names) fs.writeFileSync(path.join(directory, name), "test");
        fs.mkdirSync(path.join(directory, "stdout.2020-01-01.log"));
        createDailyLogs({ directory, now: () => new Date(2027, 0, 1) }).cleanup();
        assert(!fs.existsSync(path.join(directory, names[0])));
        for (const name of names.slice(1)) assert(fs.existsSync(path.join(directory, name)));
        assert(fs.statSync(path.join(directory, "stdout.2020-01-01.log")).isDirectory());
    });

    it("validates retention and supports a single day", () => {
        for (const retentionDays of [0, -1, 1.5, NaN]) {
            assert.throws(() => createDailyLogs({ directory, retentionDays }), /positive integer/);
        }
        fs.writeFileSync(path.join(directory, "stdout.2026-09-23.log"), "old");
        createDailyLogs({ directory, retentionDays: 1, now: () => new Date(2026, 8, 24) }).cleanup();
        assert.deepStrictEqual(fs.readdirSync(directory), []);
    });

    it("captures console, buffers and immediate exit without duplicating service output", () => {
        const modulePath = require.resolve("../bin/daily-logs");
        const output = execFileSync(process.execPath, ["-e", `
            require(${JSON.stringify(modulePath)}).installDailyLogs({ directory: ${JSON.stringify(directory)} });
            console.log('hello'); console.error('failure');
            process.stdout.write(Buffer.from('buffer\\n')); process.exit(0);
        `], { encoding: "utf8" });
        assert.strictEqual(output, "");
        const files = fs.readdirSync(directory);
        assert.strictEqual(fs.readFileSync(path.join(directory, files.find(n => n.startsWith("stdout."))), "utf8"), "hello\nbuffer\n");
        assert.strictEqual(fs.readFileSync(path.join(directory, files.find(n => n.startsWith("stderr."))), "utf8"), "failure\n");
    });

    it("falls back to original output if the log directory becomes unavailable", () => {
        const modulePath = require.resolve("../bin/daily-logs");
        const output = execFileSync(process.execPath, ["-e", `
            const fs = require('fs');
            const restore = require(${JSON.stringify(modulePath)}).installDailyLogs({ directory: ${JSON.stringify(directory)} });
            fs.rmdirSync(${JSON.stringify(directory)});
            console.log('fallback'); restore();
        `], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
        assert.strictEqual(output, "fallback\n");
    });

    it("cleans expired logs on the idle timer and does not keep the process alive", () => {
        const modulePath = require.resolve("../bin/daily-logs");
        execFileSync(process.execPath, ["-e", `
            const assert = require('assert');
            const fs = require('fs');
            const path = require('path');
            const RealDate = Date;
            let instant = new RealDate(2026, 8, 24);
            global.Date = class extends RealDate {
                constructor(...args) { super(...(args.length ? args : [instant.getTime()])); }
            };
            let tick;
            let unref = false;
            global.setInterval = (fn, ms) => {
                assert.strictEqual(ms, 60000); tick = fn;
                return { unref() { unref = true; } };
            };
            global.clearInterval = () => {};
            const file = path.join(${JSON.stringify(directory)}, 'stdout.2026-09-18.log');
            fs.writeFileSync(file, 'old');
            const restore = require(${JSON.stringify(modulePath)}).installDailyLogs({ directory: ${JSON.stringify(directory)} });
            assert(fs.existsSync(file));
            instant = new RealDate(2026, 8, 25);
            tick();
            assert(!fs.existsSync(file)); assert(unref); restore();
        `]);
    });

    it("mirrors interactive output and preserves write callbacks", () => {
        const modulePath = require.resolve("../bin/daily-logs");
        const output = execFileSync(process.execPath, ["-e", `
            const restore = require(${JSON.stringify(modulePath)}).installDailyLogs({
                directory: ${JSON.stringify(directory)}, mirror: true
            });
            process.stdout.write('interactive\\n', () => { restore(); console.log('callback'); });
        `], { encoding: "utf8" });
        assert.strictEqual(output, "interactive\ncallback\n");
        const file = fs.readdirSync(directory).find(n => n.startsWith("stdout."));
        assert.strictEqual(fs.readFileSync(path.join(directory, file), "utf8"), "interactive\n");
    });
});
