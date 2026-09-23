"use strict";

const assert = require("assert");
const shared = require("../lib/Mirakurun/_").default;
const db = require("../lib/Mirakurun/db");
const Service = require("../lib/Mirakurun/Service").default;
const Event = require("../lib/Mirakurun/Event").default;
const EPG = require("../lib/Mirakurun/EPG").default;

describe("Service database loading", () => {
    let original;
    beforeEach(() => {
        original = { loadServices: db.loadServices, channel: shared.channel, event: shared.event };
        shared.event = new Event();
        shared.channel = { get: (type, channel) => channel === "missing" ? null : {
            type, channel
        } };
    });
    afterEach(() => {
        db.loadServices = original.loadServices;
        shared.channel = original.channel;
        shared.event = original.event;
    });

    for (const invalid of [
        { channel: { type: "GR", channel: "missing" }, networkId: 1, serviceId: 2 },
        { channel: { type: "GR", channel: "13" }, serviceId: 2 },
        { channel: { type: "GR", channel: "13" }, networkId: 1 }
    ]) {
        it(`loads valid records after ${JSON.stringify(invalid)} and schedules cleanup`, () => {
            let saves = 0;
            class TestService extends Service {
                save() { saves++; }
            }
            const valid = serviceId => ({
                channel: { type: "GR", channel: "13" }, networkId: 1, serviceId
            });
            db.loadServices = () => [valid(1), invalid, valid(3)];
            const service = new TestService();
            assert.deepStrictEqual(service.items.map(item => item.serviceId), [1, 3]);
            assert.strictEqual(saves, 3); // Two additions and cleanup of the invalid record.
        });
    }
});

describe("EPG extended event text", () => {
    let originalProgram;
    let updates;
    beforeEach(() => {
        originalProgram = shared.program;
        updates = [];
        shared.program = { exists: () => true, set: (id, update) => updates.push(update) };
    });
    afterEach(() => { shared.program = originalProgram; });

    // LS1 selects alphanumeric characters; each independent item starts with fresh ARIB state.
    const label = Buffer.from([0x0e, 0x41]);
    const item = (text, continuation = false) => ({
        item_description_length: continuation ? 0 : label.length,
        item_description_char: continuation ? Buffer.alloc(0) : label,
        item_char: Buffer.from(text)
    });
    function write(epg, number, last, items) {
        epg.write({
            table_id: 0x50, version_number: 0, original_network_id: 1, service_id: 1,
            events: [{ event_id: 1, start_time: Buffer.alloc(5, 0xff), descriptors: [{
                descriptor_tag: 0x4e, descriptor_number: number, last_descriptor_number: last, items
            }] }]
        });
    }

    it("decodes repeated labels independently, preserving ARIB character state", () => {
        write(new EPG(), 0, 0, [item([0x0e, 0x41]), item([0x24, 0x22])]);
        assert.deepStrictEqual(updates, [{ extended: { "Ａ": "Ａ\n\nあ" } }]);
    });

    it("joins continuation bytes before decoding, including split multibyte characters", () => {
        const epg = new EPG();
        write(epg, 1, 1, [item([0x22], true)]);
        assert.deepStrictEqual(updates, []);
        write(epg, 0, 1, [item([0x24])]);
        assert.deepStrictEqual(updates, [{ extended: { "Ａ": "あ" } }]);
    });
});
