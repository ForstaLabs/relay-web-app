// vim: ts=4:sw=4:expandtab
/* global Backbone ifrpc */

(function() {
    'use strict';

    self.F = self.F || {};
    F.surrogate = true;

    if (!self.opener) {
        throw new Error("Surrogate can only be loaded by the main app");
    }

    F.openerRPC = ifrpc.init(self.opener, {peerOrigin: self.origin});


    const preloaded = (async () => {
        const managed = self.opener.parent !== self.opener;
        if (managed) {
            await F.initRPC(self.opener.parent, 'surrogate');
        }
        const contextReady = new Promise(resolve => {
            F.openerRPC.addCommandHandler('set-context', resolve);
        });
        F.openerRPC.triggerEvent('init');
        await Backbone.initDatabase(F.SharedCacheDatabase);
        const ctx = F.surrogateContext = await contextReady;
        await F.atlas.setCurrentUser(ctx.userId);
        await F.foundation.initSurrogate({threadId: ctx.threadId});
    })();

    async function main() {
        await preloaded;
        F.log.info('<big><b>Starting Forsta Surrogate</b></big>');

        await Promise.all([
            F.util.startIssueReporting(),
            F.util.startUsageReporting(),
            F.tpl.loadPartials(),
        ]);

        const thread = F.foundation.allThreads.get(F.surrogateContext.threadId);
        F.mainView = new F.SurrogateView({thread});
        await F.mainView.render();

        console.info(`Surrogate load time: ${Math.round(performance.now())}ms`);
    }

    addEventListener('load', main);
}());
