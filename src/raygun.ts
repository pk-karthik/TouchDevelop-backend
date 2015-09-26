/// <reference path='../typings/node/node.d.ts' />

'use strict';

import * as td from 'td';
import * as assert from 'assert';

var TD = td.TD;
type JsonObject = td.JsonObject;
type JsonBuilder = td.JsonBuilder;

var asArray = td.asArray;
var json = td.json;
var clone = td.clone;


var logger: td.AppLogger;
var pendingReports: JsonBuilder[];


export interface IOptions {
    apiKey?: string;
    version?: string;
    private?: boolean;
    saveReport?: td.JsonAction;
}

var raygun = require("raygun");


/**
 * Initializes the raygun client with the given api key. If not provided, the ``RAYGUN_API_KEY`` server setting is used. ``version`` is an optional custom version number in the format ``y.y.y.y``. This version number will be displayed in the dashboard.
 */
export async function initAsync(options_: IOptions = {}) : Promise<void>
{
    assert(logger == null, "double initialization");
    logger = td.createLogger("raygun");
    if (!options_.apiKey) {
        options_.apiKey = td.serverSetting("RAYGUN_API_KEY", false);
    }
    if (options_.saveReport != null) {
        pendingReports = [];
        /* async */ saveReportLoopAsync(options_);
    }

    var opt = options_;
    var raygunClient = new raygun.Client().init({ apiKey: opt.apiKey });
    var util = require('util');
    if(opt.version) raygunClient.setVersion(opt.version);
    td.App.addTransport({
      id: "raygun",
      log : function(level, category, message, meta) {
        // "crash" messages already reported below
        if (level <= 3 && category != "crash") {
          try { throw new Error(category + ": " + message); }
          catch(err) {  raygunClient.send(err, meta); }
        }
      },
      logException : function(err, meta) {
        logger.debug("sending crash: " + err.message);
        var req = err.tdNodeRequest
        if (pendingReports) {
            // TODO
            /*
            var js = TDev.Ticker.mkBugReport(err, "custom")
            pendingReports.item.push(js)
            if (!meta) meta = {}
            meta.reportId = js.reportId
            */
        }
        if (opt.private) {
            raygunClient.user = function() { return "anon" };
            if (req)
                req = { headers: { 'user-agent': req.headers['user-agent'] } }
            if (meta) {
                meta = clone(meta);
                delete meta.contextUser;
            }
        } else {
            raygunClient.user = function() { return meta && meta.contextUser || null };
        }
        var msg = raygunClient.send(err, meta, (resp) => {
            if (resp.statusCode >= 300) {
              logger.warning("raygun resp: " + resp.statusCode + ", retrying with TD");
              // raygun module has issues with unicode
              var r = td.createRequest("https://api.raygun.io/entries");
              r.setHeader("X-ApiKey", opt['api key']);
              r.setMethod("POST");
              r.setContentAsJson(msg);
              r.sendAsync().then(function(r){
                  logger.warning("TD retry, " + (r ? r.statusCode() : "X"));
              }, function(e){
                  logger.warning("TD retry, " + e.message);
              });
              /*
              logger.debug("raygun req: " + util.inspect(msg), s);
              logger.debug("raygun reqS: " + JSON.stringify(msg), s);
              logger.log("debug", "raygun req", lib.JsonObject.wrap(msg), s);
              resp.setEncoding("utf8");
              resp.on("data", function(d) { logger.debug("raygun msg: " + d, s) });
              */
            }
        }, req);
      }
    });
    ;
    logger.info("initialized");
}

async function exampleAsync() : Promise<void>
{
    // Sends crashes to [raygun.io](http://raygun.io).
    // ### configuration
    // Add this call in your ``_init`` action.
    await initAsync();
    // The ``init`` action takes the raygun api key. If not specified, the key is read from the ``RAYGUN_API_KEY`` server setting. ``version`` is an optional custom version number in the format ``y.y.y.y``. This version number will be displayed in the dashboard.
    // ### that's it!
    // All unhandled errors are automatically send to raygun after calling ``init``.
}

async function saveReportLoopAsync(options_: IOptions) : Promise<void>
{
    while (true) {
        if (pendingReports.length == 0) {
            await td.sleepAsync(1);
        }
        else {
            let jsb = clone(pendingReports[0]);
            pendingReports.shift();
            // Note that this may crash. It would kill this loop. This avoids sending error reports about error reports.
            // We don't think this is a problem since workers are restarted every 15 minutes.
            await options_.saveReport(jsb);
        }
    }
}


