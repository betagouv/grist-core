import { TelemetryEvent, TelemetryMetadataByLevel } from 'app/common/Telemetry';
import { Document } from 'app/gen-server/entity/Document';
import { Workspace } from 'app/gen-server/entity/Workspace';
import { Deps, Housekeeper } from 'app/gen-server/lib/Housekeeper';
import { Telemetry } from 'app/server/lib/Telemetry';
import { assert } from 'chai';
import * as fse from 'fs-extra';
import moment from 'moment';
import * as sinon from 'sinon';
import { TestServer } from 'test/gen-server/apiUtils';
import { GristClient, openClient } from 'test/server/gristClient';
import * as testUtils from 'test/server/testUtils';

import * as fs from 'node:fs';
import { ActiveSessionInfo } from 'app/common/UserAPI';

describe('Housekeeper', function() {
  testUtils.setTmpLogLevel('error');
  this.timeout(60000);

  const org: string = 'testy';
  const sandbox = sinon.createSandbox();
  const CUSTOM_CLEANUP_CACHE_PERIOD_MS = 60 * 1000; // Every minutes
  const externalStorageEnabled = Boolean(process.env.GRIST_DOCS_MINIO_ACCESS_KEY);
  let home: TestServer;
  let keeper: Housekeeper;

  before(async function() {
    Deps.CLEANUP_CACHE_PERIOD_MS = CUSTOM_CLEANUP_CACHE_PERIOD_MS;
    home = new TestServer(this);
    await home.start(['home', 'docs'], {externalStorage: externalStorageEnabled});
    const api = await home.createHomeApi('chimpy', 'docs');
    await api.newOrg({name: org, domain: org});
    keeper = home.server.housekeeper;
    await keeper.stop();
  });

  after(async function() {
    await home.stop();
  });

  afterEach(function () {
    sandbox.restore();
  });

  async function getDoc(docId: string) {
    const manager = home.dbManager.connection.manager;
    return manager.findOneOrFail(Document, {where: {id: docId}});
  }

  async function getWorkspace(wsId: number) {
    const manager = home.dbManager.connection.manager;
    return manager.findOneOrFail(Workspace, {where: {id: wsId}});
  }


  function daysAgo(days: number): Date {
    return moment().subtract(days, 'days').toDate();
  }

  async function ageDoc(docId: string, days: number) {
    const dbDoc = await getDoc(docId);
    dbDoc.removedAt = daysAgo(days);
    await dbDoc.save();
  }

  async function ageWorkspace(wsId: number, days: number) {
    const dbWorkspace = await getWorkspace(wsId);
    dbWorkspace.removedAt = daysAgo(days);
    await dbWorkspace.save();
  }

  async function ageFork(forkId: string, days: number) {
    const dbFork = await getDoc(forkId);
    dbFork.updatedAt = daysAgo(days);
    await dbFork.save();
  }

  it('can delete old soft-deleted docs and workspaces', async function() {
    // Make four docs in one workspace, two in another.
    const api = await home.createHomeApi('chimpy', org);
    const ws1 = await api.newWorkspace({name: 'ws1'}, 'current');
    const ws2 = await api.newWorkspace({name: 'ws2'}, 'current');
    const doc11 = await api.newDoc({name: 'doc11'}, ws1);
    const doc12 = await api.newDoc({name: 'doc12'}, ws1);
    const doc13 = await api.newDoc({name: 'doc13'}, ws1);
    const doc14 = await api.newDoc({name: 'doc14'}, ws1);
    const doc21 = await api.newDoc({name: 'doc21'}, ws2);
    const doc22 = await api.newDoc({name: 'doc22'}, ws2);

    // Soft-delete some of the docs, and one workspace.
    await api.softDeleteDoc(doc11);
    await api.softDeleteDoc(doc12);
    await api.softDeleteDoc(doc13);
    await api.softDeleteWorkspace(ws2);

    // Check that nothing is deleted by housekeeper.
    await keeper.deleteTrash();
    await assert.isFulfilled(getDoc(doc11));
    await assert.isFulfilled(getDoc(doc12));
    await assert.isFulfilled(getDoc(doc13));
    await assert.isFulfilled(getDoc(doc14));
    await assert.isFulfilled(getDoc(doc21));
    await assert.isFulfilled(getDoc(doc22));
    await assert.isFulfilled(getWorkspace(ws1));
    await assert.isFulfilled(getWorkspace(ws2));

    // Age a doc and workspace somewhat, but not enough to trigger hard-deletion.
    await ageDoc(doc11, 10);
    await ageWorkspace(ws2, 20);
    await keeper.deleteTrash();
    await assert.isFulfilled(getDoc(doc11));
    await assert.isFulfilled(getWorkspace(ws2));

    // Prematurely age two of the soft-deleted docs, and the soft-deleted workspace.
    await ageDoc(doc11, 40);
    await ageDoc(doc12, 40);
    await ageWorkspace(ws2, 40);

    // Make sure that exactly those docs are deleted by housekeeper.
    await keeper.deleteTrash();
    await assert.isRejected(getDoc(doc11));
    await assert.isRejected(getDoc(doc12));
    await assert.isFulfilled(getDoc(doc13));
    await assert.isFulfilled(getDoc(doc14));
    await assert.isRejected(getDoc(doc21));
    await assert.isRejected(getDoc(doc22));
    await assert.isFulfilled(getWorkspace(ws1));
    await assert.isRejected(getWorkspace(ws2));
  });

  it('enforces exclusivity of housekeeping', async function() {
    const first = keeper.deleteTrashExclusively();
    const second = keeper.deleteTrashExclusively();
    assert.equal(await first, true);
    assert.equal(await second, false);
    assert.equal(await keeper.deleteTrashExclusively(), false);
    await keeper.testClearExclusivity();
    assert.equal(await keeper.deleteTrashExclusively(), true);
  });

  it('can delete old forks', async function() {
    // Make a document with some forks.
    const api = await home.createHomeApi('chimpy', org);
    const ws3 = await api.newWorkspace({name: 'ws3'}, 'current');
    const trunk = await api.newDoc({name: 'trunk'}, ws3);
    const session = await api.getSessionActive();
    const client = await openClient(home.server, session.user.email, session.org?.domain || 'docs');
    await client.openDocOnConnect(trunk);
    const forkResponse1 = await client.send('fork', 0);
    const forkResponse2 = await client.send('fork', 0);
    const forkPath1 = home.server.getStorageManager().getPath(forkResponse1.data.docId);
    const forkPath2 = home.server.getStorageManager().getPath(forkResponse2.data.docId);
    const forkId1 = forkResponse1.data.forkId;
    const forkId2 = forkResponse2.data.forkId;

    // Age the forks somewhat, but not enough to trigger hard-deletion.
    await ageFork(forkId1, 10);
    await ageFork(forkId2, 20);
    await keeper.deleteTrash();
    await assert.isFulfilled(getDoc(forkId1));
    await assert.isFulfilled(getDoc(forkId2));
    assert.equal(await fse.pathExists(forkPath1), true);
    assert.equal(await fse.pathExists(forkPath2), true);

    // Age one of the forks beyond the cleanup threshold.
    await ageFork(forkId2, 40);

    // Make sure that only that fork is deleted by housekeeper.
    await keeper.deleteTrash();
    await assert.isFulfilled(getDoc(forkId1));
    await assert.isRejected(getDoc(forkId2));
    assert.equal(await fse.pathExists(forkPath1), true);
    assert.equal(await fse.pathExists(forkPath2), false);
  });

  it('can log metrics about sites', async function() {
    const logMessages: [TelemetryEvent, TelemetryMetadataByLevel?][] = [];
    sandbox.stub(Telemetry.prototype, 'shouldLogEvent').callsFake((name) => true);
    sandbox.stub(Telemetry.prototype, 'logEvent').callsFake((_, name, meta) => {
      // Skip document usage events that could be arriving in the
      // middle of this test.
      if (name !== 'documentUsage') {
        logMessages.push([name, meta]);
      }
      return Promise.resolve();
    });
    await keeper.logMetrics();
    assert.isNotEmpty(logMessages);
    let [event, meta] = logMessages[0];
    assert.equal(event, 'siteUsage');
    assert.hasAllKeys(meta?.limited, [
      'siteId',
      'siteType',
      'inGoodStanding',
      'numDocs',
      'numWorkspaces',
      'numMembers',
      'lastActivity',
      'earliestDocCreatedAt',
    ]);
    assert.hasAllKeys(meta?.full, [
      'stripePlanId',
    ]);
    [event, meta] = logMessages[logMessages.length - 1];
    assert.equal(event, 'siteMembership');
    assert.hasAllKeys(meta?.limited, [
      'siteId',
      'siteType',
      'numOwners',
      'numEditors',
      'numViewers',
    ]);
    assert.isUndefined(meta?.full);
  });

  describe('cache management', function () {
    let clock: sinon.SinonFakeTimers|undefined;
    function doesFileInCache(docName: string) {
      const path = home.server.getStorageManager().getPath(docName);
      return fs.existsSync(path);
    }

    async function openDoc(docName: string, session: ActiveSessionInfo) {
      const client = await openClient(home.server, session.user.email, session.org?.domain || 'docs');
      await client.openDocOnConnect(docName);
      return client;
    }

    async function closeDocClients(clients: GristClient[], clock: sinon.SinonFakeTimers) {
      for (const client of clients) {
        await client.close();
      }
      await clock.runAllAsync(); // This ensures the documents gets closed
    }

    before(function () {
      if (!externalStorageEnabled) { this.skip(); }
    });

    afterEach(async function () {
      await clock?.runAllAsync();
      clock?.restore();
      await keeper.stop();
    });

    it('removes local copies of document after a document has been closed for a while', async function () {
      clock = sandbox.useFakeTimers({
        shouldAdvanceTime: true,
        now: Date.now()
      });
      const api = await home.createHomeApi('chimpy', org);
      const ws = await api.newWorkspace({name: 'ws-test-cache'}, 'current');
      const docOpenOnce = await api.newDoc({ name: 'doc-open-once'}, ws);
      const docOpenTwice = await api.newDoc({ name: 'doc-open-twice'}, ws);
      const session = await api.getSessionActive();

      // Check whether the documents cache are not wiped as long as they are open
      const clientOpenOnce = await openDoc(docOpenOnce, session);
      let clientOpenTwice = await openDoc(docOpenTwice, session);
      await clock.tickAsync(CUSTOM_CLEANUP_CACHE_PERIOD_MS * 3);
      await keeper.cleanupCache();
      assert.isTrue(doesFileInCache(docOpenOnce), 'the first document should remain in cache as long as it is open');
      assert.isTrue(doesFileInCache(docOpenTwice), 'the second document should remain in cache as long as it is open');

      // Now close the clients (and therefore the docs)
      await closeDocClients([clientOpenOnce, clientOpenTwice], clock);

      // Wait a bit, not enough beyond the grace period
      await clock.tickAsync(1000);
      await keeper.cleanupCache();
      assert.isTrue(doesFileInCache(docOpenOnce), 'the first document should remain within the grace period');
      assert.isTrue(doesFileInCache(docOpenTwice), 'the second document should remain within the grace period');

      // Reopen the second doc, tick beyond the grace period and run the cache cleanup
      clientOpenTwice = await openDoc(docOpenTwice, session);
      await clock.tickAsync(CUSTOM_CLEANUP_CACHE_PERIOD_MS * 2);
      await keeper.cleanupCache();
      assert.isFalse(doesFileInCache(docOpenOnce),
        'the first document cache should have been removed after the grace period since it has been closed'
      );
      assert.isTrue(doesFileInCache(docOpenTwice), 'the second document cache should remain as it has been reopened');

      // Now close the second document, and check that its cache gets cleaned up
      await closeDocClients([clientOpenTwice], clock);
      await clock.tickAsync(CUSTOM_CLEANUP_CACHE_PERIOD_MS * 2);
      await keeper.cleanupCache();
      assert.isFalse(doesFileInCache(docOpenTwice),
        'the second document cache should be removed now that the document is closed'
      );

      // Ensure now that the method can be called without any document cache to be cleaned up
      const lastCall = keeper.cleanupCache();
      await assert.isFulfilled(lastCall, "should successfully run cleanupCache without any document to clean up");
    });
  });
});
