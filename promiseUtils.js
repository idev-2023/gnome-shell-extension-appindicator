// -*- mode: js; js-indent-level: 4; indent-tabs-mode: nil -*-
/* exported CancellablePromise, SignalConnectionPromise, IdlePromise,
   TimeoutPromise, TimeoutSecondsPromise, MetaLaterPromise, _promisify,
   _promisifySignals */

const { Gio, GLib, GObject, Meta } = imports.gi;
const Signals = imports.signals;

var CancellablePromise = class extends Promise {
    constructor(executor, cancellable) {
        if (!(executor instanceof Function))
            throw TypeError('executor is not a function');

        if (cancellable && !(cancellable instanceof Gio.Cancellable))
            throw TypeError('cancellable parameter is not a Gio.Cancellable');

        let rejector;
        let resolver;
        super((resolve, reject) => {
            resolver = resolve;
            rejector = reject;
        });

        const { stack: promiseStack } = new Error();
        this._promiseStack = promiseStack;

        this._resolver = (...args) => {
            resolver(...args);
            this._resolved = true;
            this._cleanup();
        };
        this._rejector = (...args) => {
            rejector(...args);
            this._rejected = true;
            this._cleanup();
        };

        if (!cancellable) {
            executor(this._resolver, this._rejector);
            return;
        }

        this._cancellable = cancellable;
        this._cancelled = cancellable.is_cancelled();
        if (this._cancelled) {
            this._rejector(new GLib.Error(Gio.IOErrorEnum,
                Gio.IOErrorEnum.CANCELLED, 'Promise cancelled'));
            return;
        }

        this._cancellationId = cancellable.connect(() => {
            const id = this._cancellationId;
            this._cancellationId = 0;
            GLib.idle_add(GLib.PRIORITY_DEFAULT, () => cancellable.disconnect(id));
            this.cancel();
        });

        executor(this._resolver, this._rejector);
    }

    _cleanup() {
        if (this._cancellationId)
            this._cancellable.disconnect(this._cancellationId);
    }

    get cancellable() {
        return this._chainRoot._cancellable || null;
    }

    get _chainRoot() {
        return this._root ? this._root : this;
    }

    then(...args) {
        const ret = super.then(...args);

        /* Every time we call then() on this promise we'd get a new
         * CancellablePromise however that won't have the properties that the
         * root one has set, and then it won't be possible to cancel a promise
         * chain from the last one.
         * To allow this we keep track of the root promise, make sure that
         * the same method on the root object is called during cancellation
         * or any destruction method if you want this to work. */
        if (ret instanceof CancellablePromise)
            ret._root = this._chainRoot;

        return ret;
    }

    resolved() {
        return !!this._chainRoot._resolved;
    }

    rejected() {
        return !!this._chainRoot._rejected;
    }

    cancelled() {
        return !!this._chainRoot._cancelled;
    }

    pending() {
        return !this.resolved() && !this.rejected();
    }

    cancel() {
        if (this._root) {
            this._root.cancel();
            return this;
        }

        if (!this.pending())
            return this;

        this._cancelled = true;
        const error = new GLib.Error(Gio.IOErrorEnum,
            Gio.IOErrorEnum.CANCELLED, 'Promise cancelled');
        error.stack += `## Promise created at:\n${this._promiseStack}`;
        this._rejector(error);

        return this;
    }
};

var SignalConnectionPromise = class extends CancellablePromise {
    constructor(object, signal, cancellable) {
        if (arguments.length === 1 && object instanceof Function) {
            super(object);
            return;
        }

        if (!(object.connect instanceof Function))
            throw new TypeError('Not a valid object');

        if (object instanceof GObject.Object &&
            !GObject.signal_lookup(signal.split(':')[0], object.constructor.$gtype))
            throw new TypeError(`Signal ${signal} not found on object ${object}`);

        let id;
        let destroyId;
        super(resolve => {
            let connectSignal;
            if (object instanceof GObject.Object)
                connectSignal = (sig, cb) => GObject.signal_connect(object, sig, cb);
            else
                connectSignal = (sig, cb) => object.connect(sig, cb);

            id = connectSignal(signal, (_obj, ...args) => {
                if (!args.length)
                    resolve();
                else
                    resolve(args.length === 1 ? args[0] : args);
            });

            if (signal !== 'destroy' &&
                (!(object instanceof GObject.Object) ||
                 GObject.signal_lookup('destroy', object.constructor.$gtype)))
                destroyId = connectSignal('destroy', () => this.cancel());
        }, cancellable);

        this._object = object;
        this._id = id;
        this._destroyId = destroyId;
    }

    _cleanup() {
        if (this._id) {
            let disconnectSignal;

            if (this._object instanceof GObject.Object)
                disconnectSignal = id => GObject.signal_handler_disconnect(this._object, id);
            else
                disconnectSignal = id => this._object.disconnect(id);

            disconnectSignal(this._id);
            if (this._destroyId) {
                disconnectSignal(this._destroyId);
                this._destroyId = 0;
            }
            this._object = null;
            this._id = 0;
        }

        super._cleanup();
    }

    get object() {
        return this._chainRoot._object;
    }
};

var GSourcePromise = class extends CancellablePromise {
    constructor(gsource, priority, cancellable) {
        if (arguments.length === 1 && gsource instanceof Function) {
            super(gsource);
            return;
        }

        if (gsource.constructor.$gtype !== GLib.Source.$gtype)
            throw new TypeError(`gsource ${gsource} is not of type GLib.Source`);

        if (priority === undefined)
            priority = GLib.PRIORITY_DEFAULT;
        else if (!Number.isInteger(priority))
            throw TypeError('Invalid priority');

        super(resolve => {
            gsource.set_priority(priority);
            gsource.set_callback(() => {
                resolve();
                return GLib.SOURCE_REMOVE;
            });
            gsource.attach(null);
        }, cancellable);

        this._gsource = gsource;
        this._gsource.set_name(`[gnome-shell] ${this.constructor.name} ${
            new Error().stack.split('\n').filter(line =>
                !line.match(/misc\/promiseUtils\.js/))[0]}`);

        if (this.rejected())
            this._gsource.destroy();
    }

    get gsource() {
        return this._chainRoot._gsource;
    }

    _cleanup() {
        if (this._gsource) {
            this._gsource.destroy();
            this._gsource = null;
        }
        super._cleanup();
    }
};

var IdlePromise = class extends GSourcePromise {
    constructor(priority, cancellable) {
        if (arguments.length === 1 && priority instanceof Function) {
            super(priority);
            return;
        }

        if (priority === undefined)
            priority = GLib.PRIORITY_DEFAULT_IDLE;

        super(GLib.idle_source_new(), priority, cancellable);
    }
};

var TimeoutPromise = class extends GSourcePromise {
    constructor(interval, priority, cancellable) {
        if (arguments.length === 1 && interval instanceof Function) {
            super(interval);
            return;
        }

        if (!Number.isInteger(interval) || interval < 0)
            throw TypeError('Invalid interval');

        super(GLib.timeout_source_new(interval), priority, cancellable);
    }
};

var TimeoutSecondsPromise = class extends GSourcePromise {
    constructor(interval, priority, cancellable) {
        if (arguments.length === 1 && interval instanceof Function) {
            super(interval);
            return;
        }

        if (!Number.isInteger(interval) || interval < 0)
            throw TypeError('Invalid interval');

        super(GLib.timeout_source_new_seconds(interval), priority, cancellable);
    }
};

var MetaLaterPromise = class extends CancellablePromise {
    constructor(laterType, cancellable) {
        if (arguments.length === 1 && laterType instanceof Function) {
            super(laterType);
            return;
        }

        if (laterType && laterType.constructor.$gtype !== Meta.LaterType.$gtype)
            throw new TypeError(`laterType ${laterType} is not of type Meta.LaterType`);
        else if (!laterType)
            laterType = Meta.LaterType.BEFORE_REDRAW;

        let id;
        super(resolve => {
            id = Meta.later_add(laterType, () => {
                this.remove();
                resolve();
                return GLib.SOURCE_REMOVE;
            });
        }, cancellable);

        this._id = id;
    }

    _cleanup() {
        if (this._id) {
            Meta.later_remove(this._id);
            this._id = 0;
        }
        super._cleanup();
    }
};

function _promisifySignals(proto) {
    if (proto.connect_once)
        return;

    proto.connect_once = function (signal, cancellable) {
        return new SignalConnectionPromise(this, signal, cancellable);
    };
}

const addSignalMethods = Signals.addSignalMethods;
Signals.addSignalMethods = proto => {
    addSignalMethods(proto);
    _promisifySignals(proto);
};

_promisifySignals(GObject.Object.prototype);

var _promisify = Gio._promisify;
if (imports.system.version < 16501) {
    /* This is backported from upstream gjs, so that all the features are available */
    _promisify = function (proto, asyncFunc,
        finishFunc = `${asyncFunc.replace(/_(begin|async)$/, '')}_finish`) {
        if (proto[asyncFunc] === undefined)
            throw new Error(`${proto} has no method named ${asyncFunc}`);

        if (proto[finishFunc] === undefined)
            throw new Error(`${proto} has no method named ${finishFunc}`);

        if (proto[`_original_${asyncFunc}`] !== undefined)
            return;
        proto[`_original_${asyncFunc}`] = proto[asyncFunc];
        proto[asyncFunc] = function (...args) {
            if (!args.every(arg => typeof arg !== 'function'))
                return this[`_original_${asyncFunc}`](...args);
            return new Promise((resolve, reject) => {
                const callStack = new Error().stack.split('\n').filter(line => !line.match(/promisify/)).join('\n');
                this[`_original_${asyncFunc}`](...args, (source, res) => {
                    try {
                        const result = source !== null && source[finishFunc] !== undefined
                            ? source[finishFunc](res)
                            : proto[finishFunc](res);
                        if (Array.isArray(result) && result.length > 1 && result[0] === true)
                            result.shift();
                        resolve(result);
                    } catch (error) {
                        if (error.stack)
                            error.stack += `### Promise created here: ###\n${callStack}`;
                        else
                            error.stack = callStack;
                        reject(error);
                    }
                });
            });
        };
    };
}

if (!Promise.allSettled) {
    Promise.allSettled = function (promises) {
        let wrappedPromises = promises.map(p => Promise.resolve(p)
            .then(
                val => ({ status: 'fulfilled', value: val }),
                err => ({ status: 'rejected', reason: err })));
        return Promise.all(wrappedPromises);
    };
}
