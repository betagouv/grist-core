import {detectCurrentLang, makeT} from 'app/client/lib/localization';
import {createSessionObs} from 'app/client/lib/sessionObs';
import {getTimeFromNow} from 'app/client/lib/timeUtils';
import {DocPageModel} from 'app/client/models/DocPageModel';
import {reportError} from 'app/client/models/errors';
import {urlState} from 'app/client/models/gristUrlState';
import {buildConfigContainer} from 'app/client/ui/RightPanelUtils';
import {buttonSelect} from 'app/client/ui2018/buttonSelect';
import {testId, theme, vars} from 'app/client/ui2018/cssVars';
import {icon} from 'app/client/ui2018/icons';
import {menu, menuAnnotate, menuItemLink} from 'app/client/ui2018/menus';
import {buildUrlId, parseUrlId} from 'app/common/gristUrls';
import {StringUnion} from 'app/common/StringUnion';
import {DocSnapshot} from 'app/common/UserAPI';
import {Disposable, dom, IDomComponent, MultiHolder, Observable, styled} from 'grainjs';

const t = makeT('DocHistory');

const DocHistorySubTab = StringUnion("activity", "snapshots");

export class DocHistory extends Disposable implements IDomComponent {
  private _subTab = createSessionObs(this, "docHistorySubTab", "snapshots", DocHistorySubTab.guard);
  private _dateFormatter;
  private _relativeTimeFormatter;

  constructor(private _docPageModel: DocPageModel, private _actionLog: IDomComponent) {
    super();
    const currentLang = detectCurrentLang();
    this._dateFormatter = new Intl.DateTimeFormat(currentLang, {
      weekday: 'short',
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
    });
    this._relativeTimeFormatter = new Intl.RelativeTimeFormat(currentLang, {
      numeric: "always", // Don't use "auto", it is confusing when
    });
    // FIXME: remove this
    (window as any).testMe = this._formatRelTime.bind(this);
  }

  public buildDom() {
    const tabs = [
      {value: 'activity', label: t("Activity")},
      {value: 'snapshots', label: t("Snapshots")},
    ];
    return [
      cssSubTabs(
        buttonSelect(this._subTab, tabs, {}, testId('doc-history-tabs')),
      ),
      dom.domComputed(this._subTab, (subTab) =>
        buildConfigContainer(
          subTab === 'activity' ? this._actionLog.buildDom() :
          subTab === 'snapshots' ? dom.create(this._buildSnapshots.bind(this)) :
          null
        )
      ),
    ];
  }

  private _buildSnapshots(owner: MultiHolder) {
    // Fetch snapshots, and render.
    const doc = this._docPageModel.currentDoc.get();
    if (!doc) { return null; }

    // origUrlId is the snapshot-less URL, which we use to fetch snapshot history, and for
    // snapshot comparisons.
    const origUrlId = buildUrlId({...doc.idParts, snapshotId: undefined});

    // If comparing one snapshot to another, get the other ID, so that we can highlight it too.
    const compareUrlId = urlState().state.get().params?.compare;
    const compareSnapshotId = compareUrlId && parseUrlId(compareUrlId).snapshotId;

    // Helper to set a link to open a snapshot, optionally comparing it with a docId.
    // We include urlState().state to preserve the currently selected page.
    function setLink(snapshot: DocSnapshot, compareDocId?: string) {
      return dom.attr('href', (use) => urlState().makeUrl({
        ...use(urlState().state), doc: snapshot.docId,
        params: (compareDocId ? {compare: compareDocId} : {})
      }));
    }

    const snapshots = Observable.create<DocSnapshot[]>(owner, []);
    const snapshotsDenied = Observable.create<boolean>(owner, false);
    const userApi = this._docPageModel.appModel.api;
    const docApi = userApi.getDocAPI(origUrlId);
    docApi.getSnapshots().then(result =>
      snapshots.isDisposed() || snapshots.set(result.snapshots)).catch(err => {
        snapshotsDenied.set(true);
        // "cannot confirm access" is what we expect if snapshots
        // are denied because of access rules.
        if (!String(err).match(/cannot confirm access/)) {
          reportError(err);
        }
      });
    return dom(
      'div',
      {tabIndex: '-1'},  // Voodoo needed to allow copying text.
      dom.maybe(snapshotsDenied, () => cssSnapshotDenied(
        dom(
          'p',
          t("Snapshots are unavailable."),
        ),
        dom(
          'p',
          t("Only owners have access to snapshots for documents with access rules."),
        ),
        testId('doc-history-error'))),
      // Note that most recent snapshots are first.
      dom.domComputed(snapshots, (snapshotList) => snapshotList.map((snapshot, index) => {
        const formattedLastModified = this._dateFormatter.format(new Date(snapshot.lastModified));
        const prevSnapshot = snapshotList[index + 1] || null;
        const isSelected = Boolean(
          snapshot.snapshotId === doc.idParts.snapshotId ||
            (compareSnapshotId && snapshot.snapshotId === compareSnapshotId)
        );
        const isCurrent = index === 0;
        return cssSnapshot(
          cssSnapshotTime(getTimeFromNow(snapshot.lastModified)),
          cssSnapshotCard(
            cssSnapshotCard.cls('-active', isSelected),
            dom('div', {title: formattedLastModified}, isCurrent ? t('Current version') :
              cssDatePart(formattedLastModified)
            ),
            cssMenuDots(icon('Dots'),
              menu(() => [
                  menuItemLink(setLink(snapshot), t("Open Snapshot")),
                  menuItemLink(setLink(snapshot, origUrlId), t("Compare to Current"),
                    menuAnnotate(t("Beta"))),
                  prevSnapshot && menuItemLink(setLink(prevSnapshot, snapshot.docId), t("Compare to Previous"),
                    menuAnnotate(t("Beta"))),
                ],
                {placement: 'bottom-end', parentSelectorToMark: '.' + cssSnapshotCard.className}
              ),
              testId('doc-history-snapshot-menu'),
            ),
            testId('doc-history-card'),
          ),
          testId('doc-history-snapshot'),
        );
      })),
    );
  }

  private _formatRelTime(seconds: number) {
    const upgradeUnitsWhenValueAbove: { [unitName: string]: number } = {
      seconds: 60,
      minutes: 60,
      hours: 24,
      days: 30,
      months: 12,
      year: Infinity
    };

    let curValue = seconds;
    for (const [unitName, valueForUpgrade] of Object.entries(upgradeUnitsWhenValueAbove)) {
      // FIXME: maybe add or substract value for some units so we can use numeric: "auto".
      // Say we are the 15th of October, we should display "last month" when the value is for between 1st and 15th of September.
      if (Math.abs(curValue) < valueForUpgrade) {
        return this._relativeTimeFormatter.format(curValue, unitName as Intl.RelativeTimeFormatUnit);
      }
      curValue = Math.round(curValue / valueForUpgrade);
    }
    return this._relativeTimeFormatter.format(curValue, 'year');
  }
}

const cssSubTabs = styled('div', `
  padding: 16px;
  border-bottom: 1px solid ${theme.pagePanelsBorder};
`);

const cssSnapshot = styled('div', `
  margin: 8px 16px;
`);

const cssSnapshotDenied = styled('div', `
  margin: 8px 16px;
  text-align: center;
  color: ${theme.text};
`);

const cssSnapshotTime = styled('div', `
  text-align: right;
  color: ${theme.lightText};
  font-size: ${vars.smallFontSize};
`);

const cssSnapshotCard = styled('div', `
  border: 1px solid ${theme.documentHistorySnapshotBorder};
  padding: 8px;
  color: ${theme.documentHistorySnapshotFg};
  background: ${theme.documentHistorySnapshotBg};
  border-radius: 8px;
  overflow: hidden;
  display: flex;
  align-items: center;
  --icon-color: ${theme.controlSecondaryFg};

  &-active {
    background-color: ${theme.documentHistorySnapshotSelectedBg};
    color: ${theme.documentHistorySnapshotSelectedFg};
    --icon-color: ${theme.documentHistorySnapshotSelectedFg};
  }
`);

const cssDatePart = styled('span', `
  display: inline-block;
`);

const cssMenuDots = styled('div', `
  flex: none;
  margin: 0 4px 0 auto;
  height: 24px;
  width: 24px;
  padding: 4px;
  line-height: 0px;
  border-radius: 3px;
  cursor: default;
  &:hover, &.weasel-popup-open {
    background-color: ${theme.hover};
  }
`);
