import * as gutil from 'app/common/gutil';
import * as fs from 'fs';
import {ActionHistoryImpl} from 'app/server/lib/ActionHistoryImpl';
import {DocStorage} from 'app/server/lib/DocStorage';
import log from 'app/server/lib/log';
import {create} from "app/server/lib/create";

export async function dumpWeeklyActionStats(docPath: string, keepN: number) {
  if (!docPath || !gutil.endsWith(docPath, '.grist')) {
    throw new Error('Invalid document: Document should be a valid .grist file');
  }

  const storageManager = await create.createLocalDocStorageManager(".", ".");
  const docStorage = new DocStorage(storageManager, docPath);
  await docStorage.openFile();
  try {
    const history = new ActionHistoryImpl(docStorage);
    await history.initialize();
    const actions = await history.getRecentActions(keepN)
    type StringToStringMap = { 
        [name: string]: {[name2: string]: number}
    }
    const periodSummary: StringToStringMap = {}
    actions.forEach(a => {
      const info = a.info[1]
      const d = new Date(info.time)
      const period = d.toISOString().slice(0,10)
      periodSummary[period] = periodSummary[period] || new Map<string, Number>();
      periodSummary[period][info.user] = 1 + (periodSummary[period][info.user] || 0)
    })
    const statPath = gutil.removeSuffix(docPath, '.grist') + "-stats.json";
    fs.writeFileSync(statPath, JSON.stringify(periodSummary, null, 2))
    log.info(`dumpWeeklyActionStats ${statPath}`);
  } finally {
    await docStorage.shutdown();
  }
}
