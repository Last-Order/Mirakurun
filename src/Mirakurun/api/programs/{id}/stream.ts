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
import { Operation } from "express-openapi";
import * as api from "../../../api";
import * as log from "../../../log";
import _ from "../../../_";

export const parameters = [
    {
        in: "path",
        name: "id",
        type: "integer",
        minimum: 10000000000,
        maximum: 655356553565535,
        required: true
    },
    {
        in: "header",
        name: "X-Mirakurun-Priority",
        type: "integer",
        minimum: 0
    },
    {
        in: "query",
        name: "decode",
        type: "integer",
        minimum: 0,
        maximum: 1
    }
];

export const get: Operation = (req, res) => {

    const program = _.program.get(req.params.id as any as number);

    if (program === null) {
        api.responseError(res, 404);
        return;
    }

    (<any> res.socket)._writableState.highWaterMark = Math.max(res.writableHighWaterMark, 1024 * 1024 * 16);
    res.socket.setNoDelay(true);

    const userId = (req.ip || "unix") + ":" + (req.socket.remotePort || Date.now());
    const startedAt = Date.now();
    const priority = parseInt(req.get("X-Mirakurun-Priority"), 10) || 0;
    const disableDecoder = (<number> <any> req.query.decode === 0);
    let requestAborted = false;
    let phase = "initializing stream";

    const pendingTimer = setTimeout(() => {
        if (res.headersSent === false) {
            log.warn(
                "Program stream HTTP request `%s` has not started responding after %dms (phase=%s, programId=%s, aborted=%s)",
                userId, Date.now() - startedAt, phase, program.id, req.aborted
            );
        }
    }, 5000);

    req.once("close", () => {
        requestAborted = true;
        clearTimeout(pendingTimer);
        log.info(
            "Program stream HTTP request `%s` closed after %dms (phase=%s, programId=%s, headersSent=%s, aborted=%s)",
            userId, Date.now() - startedAt, phase, program.id, res.headersSent, req.aborted
        );
    });

    log.info(
        "Program stream HTTP request `%s` received (programId=%s, networkId=%s, serviceId=%s, eventId=%s, priority=%d, decode=%s, agent=%s)",
        userId, program.id, program.networkId, program.serviceId, program.eventId,
        priority, !disableDecoder, req.get("User-Agent") || "-"
    );

    _.tuner.initProgramStream(program, {
        id: userId,
        priority,
        agent: req.get("User-Agent"),
        url: req.url,
        disableDecoder
    }, res)
        .then(tsFilter => {
            if (requestAborted === true || req.aborted === true) {
                phase = "closed before initialization completed";
                return tsFilter.close();
            }

            req.once("close", () => tsFilter.close());

            res.setHeader("Content-Type", "video/MP2T");
            res.setHeader("X-Mirakurun-Tuner-User-ID", userId);
            res.status(200);
            phase = "waiting for first response bytes";

            log.info(
                "Program stream HTTP request `%s` initialized after %dms (programId=%s, headersSent=%s)",
                userId, Date.now() - startedAt, program.id, res.headersSent
            );

            req.setTimeout(1000 * 60 * 10); // 10 minites
        })
        .catch((err) => {
            phase = "initialization failed";
            clearTimeout(pendingTimer);
            log.warn(
                "Program stream HTTP request `%s` failed after %dms (programId=%s, error=%s)",
                userId, Date.now() - startedAt, program.id, err && err.message ? err.message : err
            );
            api.responseStreamErrorHandler(res, err);
        });
};

get.apiDoc = {
    tags: ["programs", "stream"],
    operationId: "getProgramStream",
    produces: ["video/MP2T"],
    responses: {
        200: {
            description: "OK",
            headers: {
                "X-Mirakurun-Tuner-User-ID": {
                    type: "string"
                }
            }
        },
        404: {
            description: "Not Found"
        },
        503: {
            description: "Tuner Resource Unavailable"
        },
        default: {
            description: "Unexpected Error"
        }
    }
};
