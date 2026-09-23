"use strict";

const fs = require("fs");
const path = require("path");

function dateKey(date) {
    return [date.getFullYear(), String(date.getMonth() + 1).padStart(2, "0"),
        String(date.getDate()).padStart(2, "0")].join("-");
}

function createDailyLogs({ directory, retentionDays = 7, now = () => new Date() }) {
    if (!Number.isInteger(retentionDays) || retentionDays < 1) {
        throw new Error("MIRAKURUN_LOG_RETENTION_DAYS must be a positive integer");
    }
    fs.mkdirSync(directory, { recursive: true });

    function cleanup() {
        const cutoff = new Date(now().getTime());
        cutoff.setDate(cutoff.getDate() - (retentionDays - 1));
        const oldest = dateKey(cutoff);
        for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
            const match = /^(stdout|stderr)\.(\d{4}-\d{2}-\d{2})\.log$/.exec(entry.name);
            if (entry.isFile() && match && match[2] < oldest) {
                fs.unlinkSync(path.join(directory, entry.name));
            }
        }
    }

    function write(channel, chunk, encoding) {
        if (channel !== "stdout" && channel !== "stderr") {
            throw new Error("Invalid log channel");
        }
        // Opening for append on each write avoids rename/handle races on Windows,
        // and leaves no buffered records behind when existing code calls exit().
        fs.appendFileSync(path.join(directory, `${channel}.${dateKey(now())}.log`), chunk,
            typeof encoding === "string" ? encoding : undefined);
    }

    return { cleanup, write };
}

function installDailyLogs({ directory, retentionDays = 7, mirror = false }) {
    const logger = createDailyLogs({ directory, retentionDays });
    const originals = { stdout: process.stdout.write, stderr: process.stderr.write };
    let lastDiagnostic = -Infinity;
    function report(error) {
        if (Date.now() - lastDiagnostic < 60000) return;
        lastDiagnostic = Date.now();
        originals.stderr.call(process.stderr, `Mirakurun daily log error: ${error.message}\n`);
    }
    function cleanup() {
        try { logger.cleanup(); } catch (error) { report(error); }
    }
    cleanup();
    // Run even when the server is idle. Calendar-based cutoff handles DST.
    const timer = setInterval(cleanup, 60000);
    timer.unref();
    for (const channel of ["stdout", "stderr"]) {
        const stream = process[channel];
        stream.write = function (chunk, encoding, callback) {
            let failed = false;
            try { logger.write(channel, chunk, encoding); } catch (error) {
                failed = true;
                report(error);
            }
            if (mirror || failed) {
                return originals[channel].call(stream, chunk, encoding, callback);
            }
            const done = typeof encoding === "function" ? encoding : callback;
            if (typeof done === "function") process.nextTick(done);
            return true;
        };
    }
    return () => {
        clearInterval(timer);
        for (const channel of ["stdout", "stderr"]) process[channel].write = originals[channel];
    };
}

module.exports = { createDailyLogs, installDailyLogs };
