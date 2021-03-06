// vim: ts=4:sw=4:expandtab

(function () {
    'use strict';

    self.F = self.F || {};

    class AsyncEventTarget {

        async dispatchEvent(ev) {
            if (!(ev instanceof Event)) {
                throw new TypeError('Expects an event');
            }
            if (!this._listeners || !this._listeners[ev.type]) {
                return;
            }
            for (const callback of this._listeners[ev.type]) {
                try {
                    await callback.call(this, ev);
                } catch(e) {
                    console.error(`Event Listener Exception [${ev.type}]:`, e);
                }
            }
        }

        addEventListener(eventName, callback) {
            if (typeof eventName !== 'string') {
                throw new TypeError('First argument expects a string');
            }
            if (typeof callback !== 'function') {
                throw new TypeError('Second argument expects a function');
            }
            if (!this._listeners) {
                this._listeners = {};
            }
            if (!this._listeners[eventName]) {
                this._listeners[eventName] = [callback];
            } else {
                this._listeners[eventName].push(callback);
            }
        }

        removeEventListener(eventName, callback) {
            if (typeof eventName !== 'string') {
                throw new TypeError('First argument expects a string');
            }
            if (typeof callback !== 'function') {
                throw new TypeError('Second argument expects a function');
            }
            if (!this._listeners[eventName]) {
                return;
            }
            this._listeners[eventName] = this._listeners[eventName].filter(x => x !== callback);
        }
    }

    AsyncEventTarget.prototype.on = AsyncEventTarget.prototype.addEventListener;
    AsyncEventTarget.prototype.off = AsyncEventTarget.prototype.removeEventListener;

    F.AsyncEventTarget = AsyncEventTarget;
})();

