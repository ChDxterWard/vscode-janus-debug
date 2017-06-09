'use strict';

import * as crypto from 'crypto';
import * as fs from 'fs';
import { decode, encodingExists } from 'iconv-lite';
import { Constants, detect } from 'jschardet';
import { IPC } from 'node-ipc';
import { parse, ParsedPath, sep } from 'path';
import { ipc } from './debugSession';
import { Logger } from './log';

const log = Logger.create('SourceMap');

class ValueMap<K, V> extends Map<K, V> {

    public findKeyIf(predicate: (value: V) => boolean): K | undefined {
        for (const entry of this) {
            if (predicate(entry[1])) {
                return entry[0];
            }
        }
        return undefined;
    }

    public findValueIf(predicate: (value: V) => boolean): V | undefined {
        for (const value of this.values()) {
            if (predicate(value)) {
                return value;
            }
        }
        return undefined;
    }
}

function randU32(): Promise<number> {
    return new Promise<number>((resolve, reject) => {
        crypto.randomBytes(4, (err, buf) => {
            if (err) {
                reject(err);
            } else {
                resolve(buf.readUInt32BE(0, true));
            }
        });
    });
}

/**
 * A local source file.
 *
 * Does not necessarily need to exist on disk.
 */
export class LocalSource {
    /** The name of this source. Usually a file name. */
    public readonly name: string;
    /** The local absolute path to this source. */
    public readonly path: string;
    /** An array of possible alias names. */
    public aliasNames: string[];
    /** An artificial key that iff > 0 is used by VS Code to retrieve the source through the SourceRequest. */
    public sourceReference: number;

    constructor(path: string) {
        this.path = path;
        this.name = parse(path).base;
        this.aliasNames = [];
        this.sourceReference = 0;
    }

    /**
     * Bug(s).: - Sometimes vscode detects the test javascriptfile as a non UTF-8, even with a accordingly bom.
     *          - After I changed the encoding in the testfile, and save as..., it seems that i have to restart the extension, to trigger the new encoding.
     *          - The testfile is defined as utf8 by the editor -> the variable encoding seems to fail
     */
    public loadFromDisk(): Promise<string> {
        return new Promise<string>((resolve, reject) => {
            fs.readFile(this.path, (err, fileBuffer: NodeBuffer) => {
                if (err) {
                    reject(err);
                }
                this.findEncoding(fileBuffer)
                .then(
                    (encodingtype: string) => {
                        log.debug(`Sourcefile : ${this.path.split('\\')[this.path.split('\\').length - 1]} seems to have a ${encodingtype}-encoding.`);
                        // Check if the encode-decode-lib supports the actual encoding
                        if (encodingExists(encodingtype)) {
                            log.info(encodingtype + ' is supported.');
                            // The laterly encoded sourcecode.
                            let jsString: string = '';
                            // Decode the sourcecode (stored in fileBuffer), with the encoding type. Save the result in jsString.
                            jsString = decode(fileBuffer, encodingtype);
                            resolve(jsString);
                        } else {
                            log.error(encodingtype + ' is not supported.');
                            reject(err);
                        }
                    }
                );
            });
        });
    }

    private findEncoding(fileBuffer: NodeBuffer): Promise<string> {
        return new Promise<string>((resolve, reject) => {
            // Set the border for accepting high, to prevent errors
            Constants.MINIMUM_THRESHOLD = 0.95;
            // Let jschardet guessing which encoding the file seems to be
            const assumedEncoding: any = detect(fileBuffer);
            // If jschardet detect the assumed encoding by a confidence that is bottom
            // of the top confidenceborder the confidence is set to 0
            let encodingtype = assumedEncoding.confidence > Constants.MINIMUM_THRESHOLD  ? assumedEncoding.encoding : '';

            // If no encoding can be determined in a not satisfying way, we send a request
            // to the vscode-extension to ask the user.
            if (!encodingtype) {
                ipc.connectTo('sock',
                    () => {
                        ipc.of.sock.on('connect', () => {
                            // we send our request, to inform the server (vscode extension)
                            // about our need to ask the user for the encoding
                            ipc.of.sock.emit('encoding');
                            // we receive the response with the choosen encoding
                            ipc.of.sock.on('encoding-response', (choosenEncoding: string) => {
                                // set and resolve the encoding type
                                encodingtype = choosenEncoding;
                                resolve(encodingtype);
                            });
                        });
                    }
                );
            } else {
                // The autoguess about the file encoding was successful
                resolve(encodingtype);
            }
        });
    }
}

/**
 * Provides bi-directional mapping from local to remote source names.
 *
 * The Debugger Protocol speaks of URLs but these are actually no URLs but more like URIs or URNs.
 */
export class SourceMap {
    private map: ValueMap<string, LocalSource>;

    constructor() {
        this.map = new ValueMap<string, LocalSource>();
    }

    get size(): number {
        return this.map.size;
    }

    public clear(): void {
        this.map.clear();
    }

    public setAllRemoteUrls(remoteNames: string[]): void {
        log.debug(`setAllRemoteUrls: ${JSON.stringify(remoteNames)}`);

        this.map.clear();
        remoteNames.forEach(remoteName => {
            const parsedPath = parse(remoteName);
            const localSource = new LocalSource('');
            if (parsedPath.base.length > 0) {
                localSource.aliasNames.push(parsedPath.base);
            }
            this.map.set(remoteName, localSource);
        });
    }

    public addMapping(localSource: LocalSource, remoteName: string): void {
        this.map.set(remoteName, localSource);
    }

    public getRemoteUrl(localPath: string): string {
        const parsedPath = parse(localPath);
        let remoteName: string | undefined;

        remoteName = this.map.findKeyIf(value => value.path === localPath);

        if (!remoteName) {
            remoteName = this.map.findKeyIf(value => value.aliasNames.indexOf(parsedPath.base) !== -1);
        }

        if (!remoteName) {
            // Fallback
            remoteName = localPath;
            log.warn(`no remote name found for '${localPath}'`);
        }
        log.debug(`getRemoteUrl: '${localPath}' → '${remoteName}'`);
        return remoteName;
    }

    public getSource(remoteName: string): LocalSource | undefined {
        return this.map.get(remoteName);
    }

    public getSourceByReference(sourceReference: number): LocalSource | undefined {
        return sourceReference > 0 ?
            this.map.findValueIf(value => value.sourceReference === sourceReference) : undefined;
    }
}
