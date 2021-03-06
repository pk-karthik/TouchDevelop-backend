/// <reference path='../typings/node/node.d.ts' />

'use strict';

import * as td from './td';
import * as assert from 'assert';

type JsonObject = td.JsonObject;
type JsonBuilder = td.JsonBuilder;

var orEmpty = td.orEmpty;

import * as cachedStore from "./cached-store"
import * as azureTable from "./azure-table"
import * as parallel from "./parallel"

var logger: td.AppLogger;
var client: azureTable.Client;
var hardDelete: boolean = false;


type ToKey = (e:JsonBuilder) => string;

export class Store
{
    public container: cachedStore.Container;
    public kind: string = "";
    public indices: Index[];
    public client: azureTable.Client;

    /**
     * Make it possible to get all elements `e` sharing `to key(e)`
     * {action:ignoreReturn}
     */
    public async createIndexAsync(name: string, toKey: ToKey) : Promise<Index>
    {
        let index: Index;
        index = new Index();
        index.parent = this;
        index.name = name;
        index.key = toKey;
        let name2 = "idx" + this.kind + index.name;
        if (index.name == "*") {
            name2 = "idxall";
        }
        index.table = await this.client.createTableIfNotExistsAsync(name2);
        this.indices.push(index);
        return index;
    }

    public async insertAsync(bld: JsonBuilder) : Promise<void>
    {
        bld["kind"] = this.kind;
        let id = bld["id"];
        bld["pub"]["id"] = id;
        bld["pub"]["kind"] = this.kind;
        let timestamp = bld["pub"]["time"];
        if (timestamp == null || timestamp == 0) {
            timestamp = await cachedStore.nowSecondsAsync();
            bld["pub"]["time"] = timestamp;
        }
        let indexId = (10000000000 - timestamp) + "." + azureTable.createRandomId(8);
        await parallel.forAsync(this.indices.length, async (x: number) => {
            let index = this.indices[x];
            let key = index.key(bld);
            assert(key != null, id + ": " + index.name + " invalid");
            if (key != "") {
                let entity = azureTable.createEntity(key, indexId);
                entity["pub"] = id;
                // conflict may happen here on connection restart
                await index.table.insertEntityAsync(td.clone(entity), "or merge");
            }
        });
        bld["indexId"] = indexId;
        let newEntry = td.clone(bld);
        await this.container.updateAsync(id, async (entry: JsonBuilder) => {
            let prevKind = entry["kind"];
            if (prevKind == null || prevKind == "reserved") {
                let prev = entry["pub"];
                copyJson(newEntry, entry);
                // This is in case we incremented some counters before the publication was finalized.
                if (prev != null) {
                    copyJson(td.clone(prev), entry["pub"]);
                    entry["pub"]["kind"] = this.kind;
                }
            }
            else if (entry["indexId"] == indexId) {
                logger.debug("mis-reported azure error inserting for " + id);
            }
            else {
                assert(false, "conflict inserting " + id + " into " + this.container.name + ", prev=" + prevKind);
            }
        });
    }

    public getIndex(name: string) : Index
    {
        let index: Index;
        index = (<Index>null);
        for (let index2 of this.indices) {
            if (index2.name == name) {
                index = index2;
            }
        }
        return index;
    }

    public singleFetchResult(obj: JsonObject) : FetchResult
    {
        let fetchResult: FetchResult;
        fetchResult = new FetchResult();
        fetchResult.items = [obj];
        return fetchResult;
    }

    public async generateIdAsync(minNameLength: number) : Promise<string>
    {
        let id: string;
        let entry = ({ kind: "reserved", pub: { kind: "reserved" } });
        id = await this.container.insertUniqueAsync(entry, minNameLength);
        return id;
    }

    public async fetchJsonObjectsAsync(ids: string[]) : Promise<FetchResult>
    {
        let fetchResult: FetchResult;
        let entries = await this.container.getManyAsync(ids);
        let coll = (<JsonObject[]>[]);
        for (let i = 0; i < ids.length; i++) {
            let entry = entries[i];
            if (!!entry && entry["kind"] != "reserved") {
                coll.push(entry);
            }
        }
        fetchResult = new FetchResult();
        fetchResult.items = coll;
        return fetchResult;
    }

    public async fetchFromIdListAsync(ids: string[], options: JsonObject) : Promise<FetchResult>
    {
        let fetchResult: FetchResult;
        if (options != null) {
            let start = td.toNumber(options["continuation"]);
            if (start == null) {
                start = 0;
            }
            let end = start + getCount(options);
            let coll = ids.slice(start, end);
            fetchResult = await this.fetchJsonObjectsAsync(coll);
            if (end < ids.length) {
                fetchResult.continuation = end.toString();
            }
        }
        else {
            fetchResult = await this.fetchJsonObjectsAsync(ids);
        }
        return fetchResult;
    }

    public async reserveIdAsync(id: string) : Promise<void>
    {
        let entry = ({ kind: "reserved", pub: { kind: "reserved" } });
        entry["id"] = id;
        entry["pub"]["id"] = id;
        let ok = await this.container.tryInsertAsync(id, entry);
    }

    public async deleteAsync(delid: string) : Promise<boolean>
    {
        let delok: boolean;
        let delentry = null;
        await this.container.updateAsync(delid, async (entry: JsonBuilder) => {
            let kind = entry["kind"];
            if (kind != "reserved") {
                delentry = td.clone(entry);
                if (hardDelete) {
                    for (let fld of Object.keys(entry)) {
                        if (fld == "indexId" || fld == "id") {
                        }
                        else {
                            delete entry[fld];
                        }
                    }
                }
                else {
                    entry["origkind"] = kind;
                    let jsb2 = entry["pub"];
                    if (jsb2 != null) {
                        jsb2["kind"] = "reserved";
                    }
                }
                entry["kind"] = "reserved";
                entry["deletetime"] = await cachedStore.nowSecondsAsync();
            }
            else {
                logger.debug("trying to delete 'reserved' entry: " + delid)
                delentry = {};
            }
        });
        let bld = delentry;
        if (bld != null && bld.hasOwnProperty("kind")) {
            let id2 = bld["indexId"];
            await parallel.forAsync(this.indices.length, async (x: number) => {
                let index = this.indices[x];
                let key = index.key(bld);
                if (key != null && key != "") {
                    let entity = azureTable.createEntity(key, id2);
                    let ok = await index.table.tryDeleteEntityAsync(td.clone(entity));
                    if ( ! ok) {
                        logger.debug("failed to remove idx entry: " + id2 + " - " + key + " at  idx " + index.name + " of " + this.kind);
                    }
                }
            });
            delok = true;
        }
        else {
            delok = false;
        }
        return delok;
    }

    /**
     * Make it possible to get all elements `e` sharing `to key(e)`
     * {action:ignoreReturn}
     */
    public async createCustomIndexAsync(name: string, table: azureTable.Table) : Promise<Index>
    {
        let index: Index;
        index = new Index();
        index.parent = this;
        index.name = name;
        index.key = entry => "";
        index.table = table;
        this.indices.push(index);
        return index;
    }

    public async reindexAsync(pubid: string, update: td.Action1<JsonBuilder>, force = false): Promise<{}>
    {
        let before = null;
        let after = null;
        await this.container.updateAsync(pubid, async (entry: JsonBuilder) => {
            before = td.clone(entry);
            await update(entry);
            after = td.clone(entry);
        });
        let id2 = before["indexId"];
        assert(after["indexId"] == id2, "");
        await parallel.forAsync(this.indices.length, async (x: number) => {
            let index = this.indices[x];
            let beforeKey = orEmpty(index.key(before));
            let afterKey = orEmpty(index.key(after));
            if (beforeKey != afterKey || force) {
                if (beforeKey) {
                    let entity = azureTable.createEntity(beforeKey, id2);
                    let ok = await index.table.tryDeleteEntityAsync(td.clone(entity));
                }
                if (afterKey) {
                    let entity1 = azureTable.createEntity(afterKey, id2);
                    entity1["pub"] = pubid;
                    await index.table.insertEntityAsync(entity1, "or replace");
                }
            }
        });
        
        return after;
    }
}

function unique(ids: string[])
{
    let existing = {}
    return ids.filter(e => {
        if (existing.hasOwnProperty(e))
            return false;
        existing[e] = 1;
        return true;
    })
}

export class Index
{
    public parent: Store;
    public name: string = "";
    public key: ToKey;
    public table: azureTable.Table;

    public async fetchAsync(key: string, options: JsonObject) : Promise<FetchResult>
    {
        let fetchResult: FetchResult;
        let tableQuery = this.table.createQuery().partitionKeyIs(key);
        let entities = await executeTableQueryAsync(tableQuery, options);
        let ids = entities.items.map(js => td.toString(js["pub"]));
        fetchResult = await this.parent.fetchJsonObjectsAsync(unique(ids));
        fetchResult.continuation = entities.continuation;
        return fetchResult;
    }

    public async fetchAllAsync(key: string) : Promise<JsonObject[]>
    {
        let opts = ({ "count": 1000 });
        let fetchResult = await this.fetchAsync(key, td.clone(opts));
        if (fetchResult.continuation != "") {
            let coll = (<JsonObject[]>[]);
            coll.push(fetchResult.items);
            while (fetchResult.continuation != "") {
                opts["continuation"] = fetchResult.continuation;
                fetchResult = await this.fetchAsync(key, td.clone(opts));
                coll.push(fetchResult.items);
            }
            let jsb = [];
            for (let js2 of coll) {
                for (let js3 of <any[]>js2) {
                    jsb.push(js3);
                }
            }
            fetchResult.items = jsb;
        }
        return fetchResult.items;
    }

    public async forAllBatchedAsync(key: string, batch: number, process:td.Action1<JsonObject[]>) : Promise<void>
    {
        let opts = ({ "count": 200 });
        if (batch > 0) {
            opts["count"] = batch;
        }
        let fetchResult = await this.fetchAsync(key, td.clone(opts));
        await process(fetchResult.items);
        while (fetchResult.continuation != "") {
            opts["continuation"] = fetchResult.continuation;
            fetchResult = await this.fetchAsync(key, td.clone(opts));
            await process(fetchResult.items);
        }
    }

}

export class FetchResult
    extends td.JsonRecord
{
    @td.json public continuation: string = "";
    @td.json public v: number = 0;
    @td.json public items: JsonObject[];
    static createFromJson(o:JsonObject) { let r = new FetchResult(); r.fromJson(o); return r; }
}

export interface IFetchResult {
    continuation?: string;
    v?: number;
    items?: JsonObject;
}

export interface ICreateStoreOptions {
    tableClient?: azureTable.Client;
}

var indices:td.SMap<Store> = {};


export async function createStoreAsync(container: cachedStore.Container, kind: string, options: ICreateStoreOptions = {}) : Promise<Store>
{
    let store: Store;
    store = new Store();
    store.container = container;
    store.kind = kind;
    store.indices = (<Index[]>[]);
    store.client = options.tableClient;
    if (store.client == null) {
        store.client = client;
    }
    await store.createIndexAsync("*", entry => "all");
    indices[kind] = store;
    return store;
}

export function copyJson(js: JsonObject, jsb: JsonBuilder) : void
{
    for (let key of Object.keys(js)) {
        jsb[key] = js[key];
    }
}

function getCount(options: JsonObject) : number
{
    let count: number;
    count = td.toNumber(options["count"]);
    if (count == null) {
        count = 25;
    }
    count = td.clamp(1, 500, count);
    return count;
}

export async function executeTableQueryAsync(tableQuery: azureTable.TableQuery, options: JsonObject) : Promise<FetchResult>
{
    let entities: FetchResult;
    let resQuery = tableQuery.continueAt(td.toString(options["continuation"]));
    resQuery = resQuery.pageSize(getCount(options));
    let entities2 = await resQuery.fetchPageAsync();
    entities = new FetchResult();
    entities.items = entities2.items;
    entities.continuation = entities2.continuation;
    return entities;
}

export function storeByKind(kind: string) : Store
{
    if (indices.hasOwnProperty(kind))
        return indices[kind]
    return null
}

export function init(tableClient: azureTable.Client) : void
{
    if (logger == null) {
        logger = td.createLogger("idxstore");
    }
    client = tableClient;
    hardDelete = true;
}



