/*
   Copyright 2016 kanreisa

   Licensed under the Apache License, Version 2.0 (the "License");
   you may not use this file except in compliance with the License.
   You may obtain a copy of the License at

       http://www.apache.org/licenses/LICENSE-2.0

   Unless required by applicable law or agreed to in writing, software
   distributed under the License is distributed on an "AS IS" BASIS,
   WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
   See the License for the specific language governing permissions and
   limitations under the License.
*/
import { Writable } from "stream";
import { shuffle } from "lodash";
import * as common from "./common";
import * as log from "./log";
import * as db from "./db";
import _ from "./_";
import TunerDevice from "./TunerDevice";
import ChannelItem from "./ChannelItem";
import ServiceItem from "./ServiceItem";
import TSFilter from "./TSFilter";
import TSDecoder from "./TSDecoder";

export default class Tuner {

    private _devices: TunerDevice[] = [];

    constructor() {
        this._load();
    }

    get devices(): TunerDevice[] {
        return this._devices;
    }

    get(index: number): TunerDevice {

        const l = this._devices.length;
        for (let i = 0; i < l; i++) {
            if (this._devices[i].index === index) {
                return this._devices[i];
            }
        }

        return null;
    }

    typeExists(type: common.ChannelType): boolean {

        const l = this._devices.length;
        for (let i = 0; i < l; i++) {
            if (this._devices[i].config.types.includes(type) === true) {
                return true;
            }
        }

        return false;
    }

    initChannelStream(channel: ChannelItem, userReq: common.UserRequest, output: Writable): Promise<TSFilter> {

        let networkId: number;

        const services = channel.getServices();
        if (services.length !== 0) {
            networkId = services[0].networkId;
        }

        return this._initTS({
            ...userReq,
            streamSetting: {
                channel,
                networkId,
                parseEIT: true
            }
        }, output);
    }

    initServiceStream(service: ServiceItem, userReq: common.UserRequest, output: Writable): Promise<TSFilter> {

        return this._initTS({
            ...userReq,
            streamSetting: {
                channel: service.channel,
                serviceId: service.serviceId,
                networkId: service.networkId,
                parseEIT: true
            }
        }, output);
    }

    initProgramStream(program: db.Program, userReq: common.UserRequest, output: Writable): Promise<TSFilter> {

        return this._initTS({
            ...userReq,
            streamSetting: {
                channel: _.service.get(program.networkId, program.serviceId).channel,
                serviceId: program.serviceId,
                eventId: program.eventId,
                networkId: program.networkId,
                parseEIT: true
            }
        }, output);
    }

    async getEPG(channel: ChannelItem, time?: number): Promise<void> {

        let timeout: NodeJS.Timer;
        if (!time) {
            time = _.config.server.epgRetrievalTime || 1000 * 60 * 10;
        }

        let networkId: number;

        const services = channel.getServices();
        if (services.length === 0) {
            throw new Error("no available services in channel");
        }

        networkId = services[0].networkId;

        const tsFilter = await this._initTS({
            id: "Mirakurun:getEPG()",
            priority: -1,
            disableDecoder: true,
            streamSetting: {
                channel,
                networkId,
                parseEIT: true
            }
        });

        if (tsFilter === null) {
            return;
        }

        return new Promise<void>((resolve) => {
            const fin = () => {
                clearTimeout(timeout);
                tsFilter.close();
            };
            timeout = setTimeout(fin, time);
            tsFilter.once("epgReady", fin);
            tsFilter.once("close", () => {
                fin();
                resolve();
            });
        });
    }

    async getServices(channel: ChannelItem): Promise<db.Service[]> {

        const tsFilter = await this._initTS({
            id: "Mirakurun:getServices()",
            priority: -1,
            disableDecoder: true,
            streamSetting: {
                channel,
                parseNIT: true,
                parseSDT: true
            }
        });
        return new Promise<db.Service[]>((resolve, reject) => {

            let network = {
                networkId: -1,
                areaCode: -1,
                remoteControlKeyId: -1
            };
            let services: db.Service[] = null;

            setTimeout(() => tsFilter.close(), 20000);

            Promise.all<void>([
                new Promise((resolve, reject) => {
                    tsFilter.once("network", _network => {
                        network = _network;
                        resolve();
                    });
                }),
                new Promise((resolve, reject) => {
                    tsFilter.once("services", _services => {
                        services = _services;
                        resolve();
                    });
                })
            ]).then(() => tsFilter.close());

            tsFilter.once("close", () => {

                tsFilter.removeAllListeners("network");
                tsFilter.removeAllListeners("services");

                if (network.networkId === -1) {
                    reject(new Error("stream has closed before get network"));
                } else if (services === null) {
                    reject(new Error("stream has closed before get services"));
                } else {
                    if (network.remoteControlKeyId !== -1) {
                        services.forEach(service => {
                            service.remoteControlKeyId = network.remoteControlKeyId;
                        });
                    }

                    resolve(services);
                }
            });
        });
    }

    private _load(): this {

        log.debug("loading tuners...");

        const tuners = _.config.tuners;

        tuners.forEach((tuner, i) => {

            if (!tuner.name || !tuner.types || (!tuner.remoteMirakurunHost && !tuner.command)) {
                log.error("missing required property in tuner#%s configuration", i);
                return;
            }

            if (typeof tuner.name !== "string") {
                log.error("invalid type of property `name` in tuner#%s configuration", i);
                return;
            }

            if (Array.isArray(tuner.types) === false) {
                console.log(tuner);
                log.error("invalid type of property `types` in tuner#%s configuration", i);
                return;
            }

            if (!tuner.remoteMirakurunHost && typeof tuner.command !== "string") {
                log.error("invalid type of property `command` in tuner#%s configuration", i);
                return;
            }

            if (tuner.dvbDevicePath && typeof tuner.dvbDevicePath !== "string") {
                log.error("invalid type of property `dvbDevicePath` in tuner#%s configuration", i);
                return;
            }

            if (tuner.remoteMirakurunHost && typeof tuner.remoteMirakurunHost !== "string") {
                log.error("invalid type of property `remoteMirakurunHost` in tuner#%s configuration", i);
                return;
            }

            if (tuner.remoteMirakurunPort && Number.isInteger(tuner.remoteMirakurunPort) === false) {
                log.error("invalid type of property `remoteMirakurunPort` in tuner#%s configuration", i);
                return;
            }

            if (tuner.remoteMirakurunDecoder !== undefined && typeof tuner.remoteMirakurunDecoder !== "boolean") {
                log.error("invalid type of property `remoteMirakurunDecoder` in tuner#%s configuration", i);
                return;
            }

            if (tuner.isDisabled) {
                return;
            }

            this._devices.push(
                new TunerDevice(i, tuner)
            );
        });

        log.info("%s of %s tuners loaded", this._devices.length, tuners.length);

        return this;
    }

    private _initTS(user: common.User, dest?: Writable): Promise<TSFilter> {

        return new Promise<TSFilter>((resolve, reject) => {

            const setting = user.streamSetting;
            const startedAt = Date.now();
            let phase = "selecting tuner";

            if (_.config.server.disableEITParsing === true) {
                setting.parseEIT = false;
            }

            const devices = this._getDevicesByType(setting.channel.type);
            const describeDevices = () => JSON.stringify(devices.map(device => ({
                index: device.index,
                pid: device.pid,
                channel: device.channel ? `${device.channel.type}/${device.channel.channel}` : null,
                isAvailable: device.isAvailable,
                isFree: device.isFree,
                isUsing: device.isUsing,
                isFault: device.isFault,
                priority: device.getPriority(),
                users: device.users.map(deviceUser => deviceUser.id)
            })));
            const slowTimer = setTimeout(() => {
                log.warn(
                    "Tuner stream request `%s` is still pending after %dms (phase=%s, devices=%s)",
                    user.id, Date.now() - startedAt, phase, describeDevices()
                );
            }, 5000);
            const resolveRequest = (tsFilter: TSFilter) => {
                clearTimeout(slowTimer);
                resolve(tsFilter);
            };
            const rejectRequest = (err: Error) => {
                clearTimeout(slowTimer);
                log.warn(
                    "Tuner stream request `%s` failed after %dms (phase=%s, error=%s, devices=%s)",
                    user.id, Date.now() - startedAt, phase, err && err.message ? err.message : err, describeDevices()
                );
                reject(err);
            };

            log.info(
                "Tuner stream request `%s` started (url=%s, channel=%s/%s, serviceId=%s, eventId=%s, priority=%d, candidates=%d)",
                user.id, user.url || "-", setting.channel.type, setting.channel.channel,
                setting.serviceId, setting.eventId, user.priority, devices.length
            );

            let tryCount = 50;
            const length = devices.length;

            function find() {

                let device: TunerDevice = null;
                let selectionReason: string = null;

                // 1. join to existing
                for (let i = 0; i < length; i++) {
                    if (devices[i].isAvailable === true && devices[i].channel === setting.channel) {
                        device = devices[i];
                        selectionReason = "join-existing";
                        break;
                    }
                }

                // x. use remote data
                if (device === null && !dest) {
                    const remoteDevice = devices.find(device => device.isRemote);
                    if (remoteDevice) {
                        if (setting.networkId !== undefined && setting.parseEIT === true) {
                            phase = `fetching remote programs on tuner #${remoteDevice.index}`;
                            remoteDevice.getRemotePrograms({ networkId: setting.networkId })
                                .then(async programs => {
                                    await common.sleep(1000);
                                    _.program.findByNetworkIdAndReplace(setting.networkId, programs);
                                    for (const service of _.service.findByNetworkId(setting.networkId)) {
                                        service.epgReady = true;
                                    }
                                    await common.sleep(1000);
                                })
                                .then(() => resolveRequest(null))
                                .catch(err => rejectRequest(err));

                            return;
                        }
                    }
                }

                // 2. start as new
                if (device === null) {
                    for (let i = 0; i < length; i++) {
                        if (devices[i].isFree === true) {
                            device = devices[i];
                            selectionReason = "free";
                            break;
                        }
                    }
                }

                // 3. replace existing
                if (device === null) {
                    for (let i = 0; i < length; i++) {
                        if (devices[i].isAvailable === true && devices[i].users.length === 0) {
                            device = devices[i];
                            selectionReason = "replace-idle";
                            break;
                        }
                    }
                }

                // 4. takeover existing
                if (device === null) {
                    devices.sort((t1, t2) => {
                        return t1.getPriority() - t2.getPriority();
                    });

                    for (let i = 0; i < length; i++) {
                        if (devices[i].isUsing === true && devices[i].getPriority() < user.priority) {
                            device = devices[i];
                            selectionReason = "priority-takeover";
                            break;
                        }
                    }
                }

                if (device === null) {
                    --tryCount;
                    if (tryCount > 0) {
                        setTimeout(find, 250);
                    } else {
                        rejectRequest(new Error("no available tuners"));
                    }
                } else {
                    phase = `starting stream on tuner #${device.index}`;
                    log.info(
                        "Tuner stream request `%s` selected TunerDevice#%d after %dms (reason=%s, pid=%s, channel=%s)",
                        user.id, device.index, Date.now() - startedAt, selectionReason, device.pid,
                        device.channel ? `${device.channel.type}/${device.channel.channel}` : "-"
                    );

                    let output: Writable;
                    if (user.disableDecoder === true || device.decoder === null) {
                        output = dest;
                    } else {
                        output = new TSDecoder({
                            output: dest,
                            command: device.decoder,
                            requestId: user.id
                        });
                    }

                    const tsFilter = new TSFilter({
                        output,
                        requestId: user.id,
                        networkId: setting.networkId,
                        serviceId: setting.serviceId,
                        eventId: setting.eventId,
                        parseNIT: setting.parseNIT,
                        parseSDT: setting.parseSDT,
                        parseEIT: setting.parseEIT,
                        tsmfRelTs: setting.channel.tsmfRelTs
                    });

                    Object.defineProperty(user, "streamInfo", {
                        get: () => tsFilter.streamInfo
                    });

                    device.startStream(user, tsFilter, setting.channel)
                        .then(() => {
                            phase = "stream initialized";
                            log.info(
                                "Tuner stream request `%s` initialized on TunerDevice#%d after %dms",
                                user.id, device.index, Date.now() - startedAt
                            );
                            resolveRequest(tsFilter);
                        })
                        .catch((err) => {
                            tsFilter.end();
                            rejectRequest(err);
                        });
                }
            }
            find();
        });
    }

    private _getDevicesByType(type: common.ChannelType): TunerDevice[] {

        const devices = [];

        const l = this._devices.length;
        for (let i = 0; i < l; i++) {
            if (this._devices[i].config.types.includes(type) === true) {
                devices.push(this._devices[i]);
            }
        }

        return shuffle(devices);
    }
}
