'use strict';

import { EventEmitter } from 'events';
import { decode, encode } from 'iconv-lite';
import { Socket } from 'net';
import { ContextCoordinator } from './context';
import { Logger } from './log';
import { Command, Response } from './protocol';
import { DebugProtocolTransport } from './transport';
const log = Logger.create('DebugConnection');

export interface ConnectionLike {
    emit(event: string, ...args: any[]): boolean;
    sendRequest(request: Command, responseHandler?: (response: Response) => Promise<any>): Promise<any>;
    handleResponse(response: Response): void;
    disconnect(): Promise<void>;
}

/**
 * Represents a connection to a target.
 * @fires DebugConnection.newContext
 */
export class DebugConnection extends EventEmitter implements ConnectionLike {
    public readonly coordinator: ContextCoordinator;
    private transport: DebugProtocolTransport;
    private responseHandlers: Map<string, (response: Response) => void>;

    constructor(socket: Socket) {
        super();

        this.responseHandlers = new Map();
        this.coordinator = new ContextCoordinator(this);
        this.transport = new DebugProtocolTransport(socket);
        this.transport.on('response', this.handleResponse);
    }

    public handleResponse = (response: Response): void => {
        log.info(`handle response: ${JSON.stringify(response)}`);
        // Check if we receive a response from the debugger with the subtype variables
        // see https://github.com/swojtasiak/jsrdbg for further explanation.
        if (response.subtype === 'variables') {
            // check that the actual content of the response also includes a variables property.
            if (response.content && response.content.hasOwnProperty('variables')) {
                if (response.content.variables[0] && response.content.variables[0].hasOwnProperty('variables')) {
                    /** The Server gives us a variabelvalue in UTF-8.
                     * To ensure that the gui can display the data in a correct manner,
                     * we decode the variablevalue, and turn the result in a js string.
                     */

                    // Take only the variables that have a value.
                    response.content.variables[0].variables.filter((variable: any) => {
                        return variable.hasOwnProperty('value');
                    })
                    // Just take the variables with a normal string value, that dont contain jsrdbg
                    .filter((variable: any) => {
                        return typeof variable.value === 'string' && variable.value.indexOf('jsrdbg') === -1;
                    // For every variable that passes the previous filters ...
                }).forEach((variable: any) => {
                        // save the current value of the variable.
                        const oldValue: string = variable.value;
                        // As we receive the variable value from the UTF-8-Server, we shall take care that all
                        // characters of the UTF-8-Encoded-Value getting decoded in a proper way.
                        // So we take the whole UTF-8-String and decode it. So we get a well formed
                        // JS/TS-String that we can show in the gui.
                        variable.value = decode(variable.value, 'UTF-8').toString();
                        for (const c of variable.value)
                        {
                            // If only one character in the value string has the code 65533, we know smth went wrong
                            // (the string maybe was allready decoded) :
                            if (c.charCodeAt(0) === 65533) {
                                // so we thurn back the deocodeprocess, by assign the old value to the current variable value.
                                variable.value = oldValue;
                            }
                        }
                    });
                }
            }
        }
        if (response.content.hasOwnProperty('id')) {
            const uuid: string = response.content.id;
            if (this.responseHandlers.has(uuid)) {
                log.debug(`found a response handler for response id "${uuid}"`);

                // Meant to be handled by a particular response handler function that was given when sending the
                // request
                const handler = this.responseHandlers.get(uuid);
                if (handler === undefined) {
                    throw new Error(`No response handler for ${uuid}`);
                }
                try {
                    handler(response);
                } finally {
                    this.responseHandlers.delete(uuid);
                }
                return;
            }
        }

        // No response handler; let the context coordinator decide on how to handle the response
        this.coordinator.handleResponse(response);
    }

    public disconnect(): Promise<void> {
        return this.transport.disconnect();
    }

    /**
     * Send given request to the target.
     * @param {Command} request - The request that is send to the target.
     * @param {Function} responseHandler - An optional handler for the response from the target, if any.
     */
    public sendRequest(request: Command, responseHandler?: (response: Response) => Promise<any>): Promise<any> {

        return new Promise<any>((resolve, reject) => {

            // If we have to wait for a response and handle it, make sure that we resolve after the handler function
            // has finished
            if (responseHandler) {
                this.registerResponseHandler(request.id, (response: Response) => {
                    responseHandler(response).then(value => {
                        resolve(value);
                    }).catch(reason => {
                        reject(reason);
                    });
                });
            }

            const message = request.toString();
            log.debug(`sendRequest: ${message.trim()}\\n`);
            this.transport.sendMessage(message);

            // If we don't have to wait for a response, resolve immediately
            if (!responseHandler) {
                resolve();
            }
        });
    }

    private registerResponseHandler(commandId: string, handler: (response: Response) => void): void {
        log.debug(`registerResponseHandler: adding handler function for command id: "${commandId}"`);
        this.responseHandlers.set(commandId, handler);
    }
}
