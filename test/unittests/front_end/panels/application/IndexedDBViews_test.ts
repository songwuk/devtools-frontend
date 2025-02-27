// Copyright 2023 The Chromium Authors. All rights reserved.
// Use of this source code is governed by a BSD-style license that can be
// found in the LICENSE file.

import * as Application from '../../../../../front_end/panels/application/application.js';
import * as Coordinator from '../../../../../front_end/ui/components/render_coordinator/render_coordinator.js';
import * as ReportView from '../../../../../front_end/ui/components/report_view/report_view.js';
import * as UI from '../../../../../front_end/ui/legacy/legacy.js';
import {
  assertElement,
  assertShadowRoot,
  getCleanTextContentFromElements,
  getElementWithinComponent,
  renderElementIntoDOM,
} from '../../helpers/DOMHelpers.js';
import {describeWithLocale} from '../../helpers/EnvironmentHelpers.js';

const coordinator = Coordinator.RenderCoordinator.RenderCoordinator.instance();

const {assert} = chai;

describeWithLocale('IDBDatabaseView', () => {
  it('renders with a title and top-level site', async () => {
    const databaseId =
        new Application.IndexedDBModel.DatabaseId('https://example.com/^0https://example.org', 'My Database');
    const database = new Application.IndexedDBModel.Database(databaseId, 1);
    const model = {} as Application.IndexedDBModel.IndexedDBModel;
    const component = new Application.IndexedDBViews.IDBDatabaseView(model, database);
    renderElementIntoDOM(component);

    assertShadowRoot(component.shadowRoot);
    await coordinator.done();
    const report = getElementWithinComponent(component, 'devtools-report', ReportView.ReportView.Report);
    assertShadowRoot(report.shadowRoot);

    const titleElement = report.shadowRoot.querySelector('.report-title');
    assert.strictEqual(titleElement?.textContent, 'My Database');
    const keys = getCleanTextContentFromElements(component.shadowRoot, 'devtools-report-key');
    assert.deepEqual(keys, ['Origin', 'Top-level site', 'Is third-party', 'Version', 'Object stores']);

    const values = getCleanTextContentFromElements(component.shadowRoot, 'devtools-report-value');
    assert.deepEqual(values, [
      'https://example.com',
      'https://example.org',
      'Yes, because the origin is outside of the top-level site',
      '1',
      '0',
    ]);
  });

  it('renders with an opaque storage key', async () => {
    const databaseId = new Application.IndexedDBModel.DatabaseId('https://example.com/^112345^267890', '');
    const database = new Application.IndexedDBModel.Database(databaseId, 1);
    const model = {} as Application.IndexedDBModel.IndexedDBModel;
    const component = new Application.IndexedDBViews.IDBDatabaseView(model, database);
    renderElementIntoDOM(component);

    assertShadowRoot(component.shadowRoot);
    await coordinator.done();
    const report = getElementWithinComponent(component, 'devtools-report', ReportView.ReportView.Report);
    assertShadowRoot(report.shadowRoot);

    const keys = getCleanTextContentFromElements(component.shadowRoot, 'devtools-report-key');
    assert.deepEqual(keys, ['Origin', 'Is third-party', 'Is opaque', 'Version', 'Object stores']);

    const values = getCleanTextContentFromElements(component.shadowRoot, 'devtools-report-value');
    assert.deepEqual(values, ['https://example.com', 'Yes, because the storage key is opaque', 'Yes', '1', '0']);
  });

  it('renders buttons', async () => {
    const databaseId = new Application.IndexedDBModel.DatabaseId('', '');
    const database = new Application.IndexedDBModel.Database(databaseId, 1);
    const model = {refreshDatabase: sinon.spy(), deleteDatabase: sinon.spy()};
    const component = new Application.IndexedDBViews.IDBDatabaseView(
        model as unknown as Application.IndexedDBModel.IndexedDBModel, database);
    renderElementIntoDOM(component);

    assertShadowRoot(component.shadowRoot);
    await coordinator.done({waitForWork: true});

    const buttons = component.shadowRoot.querySelectorAll('devtools-button');
    assert.strictEqual(buttons.length, 2);
    assertElement(buttons[0], HTMLElement);
    assert.strictEqual(buttons[0].textContent?.trim(), 'Delete database');
    const showDialog = sinon.stub(UI.UIUtils.ConfirmDialog, 'show').resolves(true);
    buttons[0].click();
    assert.isTrue(showDialog.calledOnce);
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.isTrue(model.deleteDatabase.calledOnceWithExactly(databaseId));

    assertElement(buttons[1], HTMLElement);
    assert.strictEqual(buttons[1].textContent?.trim(), 'Refresh database');
    buttons[1].click();
    assert.isTrue(model.refreshDatabase.calledOnceWithExactly(databaseId));
  });
});
