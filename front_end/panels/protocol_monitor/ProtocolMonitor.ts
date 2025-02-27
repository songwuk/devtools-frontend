// Copyright 2018 The Chromium Authors. All rights reserved.
// Use of this source code is governed by a BSD-style license that can be
// found in the LICENSE file.

import * as Host from '../../core/host/host.js';
import * as i18n from '../../core/i18n/i18n.js';
import * as Platform from '../../core/platform/platform.js';
import * as ProtocolClient from '../../core/protocol_client/protocol_client.js';
import * as SDK from '../../core/sdk/sdk.js';
import * as Bindings from '../../models/bindings/bindings.js';
import * as TextUtils from '../../models/text_utils/text_utils.js';
import * as DataGrid from '../../ui/components/data_grid/data_grid.js';
import * as IconButton from '../../ui/components/icon_button/icon_button.js';
import * as SourceFrame from '../../ui/legacy/components/source_frame/source_frame.js';
import * as UI from '../../ui/legacy/legacy.js';
import * as LitHtml from '../../ui/lit-html/lit-html.js';

import protocolMonitorStyles from './protocolMonitor.css.js';

const UIStrings = {
  /**
   *@description Text for one or a group of functions
   */
  method: 'Method',
  /**
   * @description Text in Protocol Monitor. Title for a table column which shows in which direction
   * the particular protocol message was travelling. Values in this column will either be 'sent' or
   * 'received'.
   */
  type: 'Type',
  /**
   * @description Text in Protocol Monitor of the Protocol Monitor tab. Noun relating to a network request.
   */
  request: 'Request',
  /**
   *@description Title of a cell content in protocol monitor. A Network response refers to the act of acknowledging a
  network request. Should not be confused with answer.
   */
  response: 'Response',
  /**
   *@description Text for timestamps of items
   */
  timestamp: 'Timestamp',
  /**
   *@description Title of a cell content in protocol monitor. It describes the time between sending a request and receiving a response.
   */
  elapsedTime: 'Elapsed time',
  /**
   *@description Text in Protocol Monitor of the Protocol Monitor tab
   */
  target: 'Target',
  /**
   *@description Text to record a series of actions for analysis
   */
  record: 'Record',
  /**
   *@description Text to clear everything
   */
  clearAll: 'Clear all',
  /**
   *@description Text to filter result items
   */
  filter: 'Filter',
  /**
   *@description Text for the documentation of something
   */
  documentation: 'Documentation',
  /**
   *@description Cell text content in Protocol Monitor of the Protocol Monitor tab
   *@example {30} PH1
   */
  sMs: '{PH1} ms',
  /**
   *@description Text in Protocol Monitor of the Protocol Monitor tab
   */
  noMessageSelected: 'No message selected',
  /**
   *@description Text in Protocol Monitor for the save button
   */
  save: 'Save',
  /**
   *@description Text in Protocol Monitor to describe the sessions column
   */
  session: 'Session',
  /**
   *@description A placeholder for an input in Protocol Monitor. The input accepts commands that are sent to the backend on Enter. CDP stands for Chrome DevTools Protocol.
   */
  sendRawCDPCommand: 'Send a raw `CDP` command',
  /**
   * @description A tooltip text for the input in the Protocol Monitor panel. The tooltip describes what format is expected.
   */
  sendRawCDPCommandExplanation:
      'Format: `\'Domain.commandName\'` for a command without parameters, or `\'{"command":"Domain.commandName", "parameters": {...}}\'` as a JSON object for a command with parameters. `\'cmd\'`/`\'method\'` and `\'args\'`/`\'params\'`/`\'arguments\'` are also supported as alternative keys for the `JSON` object.',

  /**
   * @description A label for a select input that allows selecting a CDP target to send the commands to.
   */
  selectTarget: 'Select a target',
};
const str_ = i18n.i18n.registerUIStrings('panels/protocol_monitor/ProtocolMonitor.ts', UIStrings);
const i18nString = i18n.i18n.getLocalizedString.bind(undefined, str_);

const timeRenderer = (value: DataGrid.DataGridUtils.CellValue): LitHtml.TemplateResult => {
  return LitHtml.html`${i18nString(UIStrings.sMs, {PH1: String(value)})}`;
};

export interface Message {
  id?: number;
  method: string;
  error: Object;
  result: Object;
  params: Object;
  sessionId?: string;
}

export interface LogMessage {
  id?: number;
  domain: string;
  method: string;
  params: Object;
  type: 'send'|'recv';
}

interface ProtocolDomain {
  readonly domain: string;
}

let protocolMonitorImplInstance: ProtocolMonitorImpl;
export class ProtocolMonitorImpl extends UI.Widget.VBox {
  private started: boolean;
  private startTime: number;
  private readonly requestTimeForId: Map<number, number>;
  private readonly dataGridRowForId: Map<number, DataGrid.DataGridUtils.Row>;
  private readonly infoWidget: InfoWidget;
  private readonly dataGridIntegrator: DataGrid.DataGridControllerIntegrator.DataGridControllerIntegrator;
  private readonly filterParser: TextUtils.TextUtils.FilterParser;
  private readonly suggestionBuilder: UI.FilterSuggestionBuilder.FilterSuggestionBuilder;
  private readonly textFilterUI: UI.Toolbar.ToolbarInput;
  private messages: LogMessage[] = [];
  private isRecording: boolean = false;

  #historyAutocompleteDataProvider = new HistoryAutocompleteDataProvider();
  #selectedTargetId?: string;

  constructor() {
    super(true);
    this.started = false;
    this.startTime = 0;
    this.dataGridRowForId = new Map();
    this.requestTimeForId = new Map();
    const topToolbar = new UI.Toolbar.Toolbar('protocol-monitor-toolbar', this.contentElement);

    this.contentElement.classList.add('protocol-monitor');
    const recordButton = new UI.Toolbar.ToolbarToggle(i18nString(UIStrings.record), 'record-start', 'record-stop');
    recordButton.addEventListener(UI.Toolbar.ToolbarButton.Events.Click, () => {
      recordButton.setToggled(!recordButton.toggled());
      this.setRecording(recordButton.toggled());
    });
    recordButton.setToggleWithRedColor(true);
    topToolbar.appendToolbarItem(recordButton);
    recordButton.setToggled(true);

    const clearButton = new UI.Toolbar.ToolbarButton(i18nString(UIStrings.clearAll), 'clear');
    clearButton.addEventListener(UI.Toolbar.ToolbarButton.Events.Click, () => {
      this.messages = [];
      this.dataGridIntegrator.update({...this.dataGridIntegrator.data(), rows: []});
      this.infoWidget.render(null);
    });
    topToolbar.appendToolbarItem(clearButton);

    const saveButton = new UI.Toolbar.ToolbarButton(i18nString(UIStrings.save), 'download');
    saveButton.addEventListener(UI.Toolbar.ToolbarButton.Events.Click, () => {
      void this.saveAsFile();
    });
    topToolbar.appendToolbarItem(saveButton);

    const split = new UI.SplitWidget.SplitWidget(true, true, 'protocol-monitor-panel-split', 250);
    split.show(this.contentElement);
    this.infoWidget = new InfoWidget();

    const dataGridInitialData: DataGrid.DataGridController.DataGridControllerData = {
      paddingRowsCount: 100,
      showScrollbar: true,
      columns: [
        {
          id: 'type',
          title: i18nString(UIStrings.type),
          sortable: true,
          widthWeighting: 1,
          visible: true,
          hideable: true,
          styles: {
            'text-align': 'center',
          },
        },
        {
          id: 'method',
          title: i18nString(UIStrings.method),
          sortable: false,
          widthWeighting: 5,
          visible: true,
          hideable: false,
        },
        {
          id: 'request',
          title: i18nString(UIStrings.request),
          sortable: false,
          widthWeighting: 5,
          visible: true,
          hideable: true,
        },
        {
          id: 'response',
          title: i18nString(UIStrings.response),
          sortable: false,
          widthWeighting: 5,
          visible: true,
          hideable: true,
        },
        {
          id: 'elapsedTime',
          title: i18nString(UIStrings.elapsedTime),
          sortable: true,
          widthWeighting: 2,
          visible: true,
          hideable: true,
        },
        {
          id: 'timestamp',
          title: i18nString(UIStrings.timestamp),
          sortable: true,
          widthWeighting: 5,
          visible: false,
          hideable: true,
        },
        {
          id: 'target',
          title: i18nString(UIStrings.target),
          sortable: true,
          widthWeighting: 5,
          visible: false,
          hideable: true,
        },
        {
          id: 'session',
          title: i18nString(UIStrings.session),
          sortable: true,
          widthWeighting: 5,
          visible: false,
          hideable: true,
        },
      ],
      rows: [],
      contextMenus: {
        bodyRow:
            (menu: UI.ContextMenu.ContextMenu, columns: readonly DataGrid.DataGridUtils.Column[],
             row: Readonly<DataGrid.DataGridUtils.Row>): void => {
              const methodColumn = DataGrid.DataGridUtils.getRowEntryForColumnId(row, 'method');
              const typeColumn = DataGrid.DataGridUtils.getRowEntryForColumnId(row, 'type');

              /**
               * You can click the "Filter" item in the context menu to filter the
               * protocol monitor entries to those that match the method of the
               * current row.
               */
              menu.defaultSection().appendItem(i18nString(UIStrings.filter), () => {
                const methodColumn = DataGrid.DataGridUtils.getRowEntryForColumnId(row, 'method');
                this.textFilterUI.setValue(`method:${methodColumn.value}`, true);
              });

              /**
               * You can click the "Documentation" item in the context menu to be
               * taken to the CDP Documentation site entry for the given method.
               */
              menu.defaultSection().appendItem(i18nString(UIStrings.documentation), () => {
                if (!methodColumn.value) {
                  return;
                }
                const [domain, method] = String(methodColumn.value).split('.');
                const type = typeColumn.value === 'sent' ? 'method' : 'event';
                Host.InspectorFrontendHost.InspectorFrontendHostInstance.openInNewTab(
                    `https://chromedevtools.github.io/devtools-protocol/tot/${domain}#${type}-${method}` as
                    Platform.DevToolsPath.UrlString);
              });
            },
      },
    };

    this.dataGridIntegrator =
        new DataGrid.DataGridControllerIntegrator.DataGridControllerIntegrator(dataGridInitialData);

    this.dataGridIntegrator.dataGrid.addEventListener('cellfocused', event => {
      const focusedRow = event.data.row;
      const infoWidgetData = {
        request: DataGrid.DataGridUtils.getRowEntryForColumnId(focusedRow, 'request'),
        response: DataGrid.DataGridUtils.getRowEntryForColumnId(focusedRow, 'response'),
        type:
            DataGrid.DataGridUtils.getRowEntryForColumnId(focusedRow, 'type').title as 'sent' | 'received' | undefined,
      };
      this.infoWidget.render(infoWidgetData);
    });

    this.dataGridIntegrator.dataGrid.addEventListener('newuserfiltertext', event => {
      this.textFilterUI.setValue(event.data.filterText, /* notify listeners */ true);
    });
    split.setMainWidget(this.dataGridIntegrator);
    split.setSidebarWidget(this.infoWidget);
    const keys = ['method', 'request', 'response', 'type', 'target', 'session'];
    this.filterParser = new TextUtils.TextUtils.FilterParser(keys);
    this.suggestionBuilder = new UI.FilterSuggestionBuilder.FilterSuggestionBuilder(keys);

    this.textFilterUI = new UI.Toolbar.ToolbarInput(
        i18nString(UIStrings.filter), '', 1, .2, '', this.suggestionBuilder.completions.bind(this.suggestionBuilder),
        true);
    this.textFilterUI.addEventListener(UI.Toolbar.ToolbarInput.Event.TextChanged, event => {
      const query = event.data as string;
      const filters = this.filterParser.parse(query);
      this.dataGridIntegrator.update({...this.dataGridIntegrator.data(), filters});
    });
    topToolbar.appendToolbarItem(this.textFilterUI);

    const bottomToolbar = new UI.Toolbar.Toolbar('protocol-monitor-bottom-toolbar', this.contentElement);
    bottomToolbar.appendToolbarItem(this.#createCommandInput());
    bottomToolbar.appendToolbarItem(this.#createTargetSelector());
  }

  #createCommandInput(): UI.Toolbar.ToolbarInput {
    const placeholder = i18nString(UIStrings.sendRawCDPCommand);
    const accessiblePlaceholder = placeholder;
    const growFactor = 1;
    const shrinkFactor = 0.2;
    const tooltip = i18nString(UIStrings.sendRawCDPCommandExplanation);
    const input = new UI.Toolbar.ToolbarInput(
        placeholder, accessiblePlaceholder, growFactor, shrinkFactor, tooltip,
        this.#historyAutocompleteDataProvider.buildTextPromptCompletions, false);
    input.addEventListener(UI.Toolbar.ToolbarInput.Event.EnterPressed, () => this.#onCommandSend(input));
    return input;
  }

  #createTargetSelector(): UI.Toolbar.ToolbarComboBox {
    const selector = new UI.Toolbar.ToolbarComboBox(() => {
      this.#selectedTargetId = selector.selectedOption()?.value;
    }, i18nString(UIStrings.selectTarget));
    selector.setMaxWidth(120);
    const targetManager = SDK.TargetManager.TargetManager.instance();
    const syncTargets = (): void => {
      selector.removeOptions();
      for (const target of targetManager.targets()) {
        selector.createOption(`${target.name()} (${target.inspectedURL()})`, target.id());
      }
    };
    targetManager.addEventListener(SDK.TargetManager.Events.AvailableTargetsChanged, syncTargets);
    syncTargets();
    return selector;
  }

  #onCommandSend(input: UI.Toolbar.ToolbarInput): void {
    const value = input.value();
    const {command, parameters} = parseCommandInput(value);
    const test = ProtocolClient.InspectorBackend.test;
    const targetManager = SDK.TargetManager.TargetManager.instance();
    const selectedTarget = this.#selectedTargetId ? targetManager.targetById(this.#selectedTargetId) : null;
    const sessionId = selectedTarget ? selectedTarget.sessionId : '';
    // TODO: TS thinks that properties are read-only because
    // in TS test is defined as a namespace.
    // @ts-ignore
    test.sendRawMessage(command, parameters, () => {}, sessionId);
    this.#historyAutocompleteDataProvider.addEntry(value);
  }

  static instance(opts: {forceNew: null|boolean} = {forceNew: null}): ProtocolMonitorImpl {
    const {forceNew} = opts;
    if (!protocolMonitorImplInstance || forceNew) {
      protocolMonitorImplInstance = new ProtocolMonitorImpl();
    }

    return protocolMonitorImplInstance;
  }

  override wasShown(): void {
    if (this.started) {
      return;
    }
    this.registerCSSFiles([protocolMonitorStyles]);
    this.started = true;
    this.startTime = Date.now();
    this.setRecording(true);
  }

  private setRecording(recording: boolean): void {
    this.isRecording = recording;
    const test = ProtocolClient.InspectorBackend.test;
    if (recording) {
      // TODO: TS thinks that properties are read-only because
      // in TS test is defined as a namespace.
      // @ts-ignore
      test.onMessageSent = this.messageSent.bind(this);
      // @ts-ignore
      test.onMessageReceived = this.messageReceived.bind(this);
    } else {
      // @ts-ignore
      test.onMessageSent = null;
      // @ts-ignore
      test.onMessageReceived = null;
    }
  }

  private targetToString(target: SDK.Target.Target|null): string {
    if (!target) {
      return '';
    }
    return target.decorateLabel(
        `${target.name()} ${target === SDK.TargetManager.TargetManager.instance().rootTarget() ? '' : target.id()}`);
  }

  // eslint-disable
  private messageReceived(message: Message, target: ProtocolClient.InspectorBackend.TargetBase|null): void {
    if (this.isRecording) {
      this.messages.push({...message, type: 'recv', domain: '-'});
    }
    if ('id' in message && message.id) {
      const existingRow = this.dataGridRowForId.get(message.id);
      if (!existingRow) {
        return;
      }
      const allExistingRows = this.dataGridIntegrator.data().rows;
      const matchingExistingRowIndex = allExistingRows.findIndex(r => existingRow === r);
      const newRowWithUpdate = {
        ...existingRow,
        cells: existingRow.cells.map(cell => {
          if (cell.columnId === 'response') {
            return {
              ...cell,
              value: JSON.stringify(message.result || message.error),

            };
          }

          if (cell.columnId === 'elapsedTime') {
            const requestTime = this.requestTimeForId.get(message.id as number);
            if (requestTime) {
              return {
                ...cell,
                value: Date.now() - requestTime,
                renderer: timeRenderer,
              };
            }
          }

          return cell;
        }),
      };

      const newRowsArray = [...this.dataGridIntegrator.data().rows];
      newRowsArray[matchingExistingRowIndex] = newRowWithUpdate;

      // Now we've updated the message, it won't be updated again, so we can delete it from the tracking map.
      this.dataGridRowForId.delete(message.id);
      this.dataGridIntegrator.update({
        ...this.dataGridIntegrator.data(),
        rows: newRowsArray,
      });
      return;
    }

    const sdkTarget = target as SDK.Target.Target | null;
    const responseIcon = new IconButton.Icon.Icon();
    responseIcon.data = {iconName: 'arrow-down', color: 'var(--icon-request)', width: '20px', height: '20px'};
    const newRow: DataGrid.DataGridUtils.Row = {
      cells: [
        {columnId: 'method', value: message.method, title: message.method},
        {columnId: 'request', value: '', renderer: DataGrid.DataGridRenderers.codeBlockRenderer},
        {
          columnId: 'response',
          value: JSON.stringify(message.params),
          renderer: DataGrid.DataGridRenderers.codeBlockRenderer,
        },
        {
          columnId: 'timestamp',
          value: Date.now() - this.startTime,
          renderer: timeRenderer,
        },
        {columnId: 'elapsedTime', value: ''},
        {columnId: 'type', value: responseIcon, title: 'received'},
        {columnId: 'target', value: this.targetToString(sdkTarget)},
        {columnId: 'session', value: message.sessionId || ''},
      ],
      hidden: false,
    };

    this.dataGridIntegrator.update({
      ...this.dataGridIntegrator.data(),
      rows: this.dataGridIntegrator.data().rows.concat([newRow]),
    });
  }

  private messageSent(
      message: {domain: string, method: string, params: Object, id: number, sessionId?: string},
      target: ProtocolClient.InspectorBackend.TargetBase|null): void {
    if (this.isRecording) {
      this.messages.push({...message, type: 'send'});
    }

    const sdkTarget = target as SDK.Target.Target | null;
    const requestResponseIcon = new IconButton.Icon.Icon();
    requestResponseIcon
        .data = {iconName: 'arrow-up-down', color: 'var(--icon-request-response)', width: '20px', height: '20px'};
    const newRow: DataGrid.DataGridUtils.Row = {
      styles: {
        '--override-data-grid-row-background-color': 'var(--override-data-grid-sent-message-row-background-color)',
      },
      cells: [
        {columnId: 'method', value: message.method, title: message.method},
        {
          columnId: 'request',
          value: JSON.stringify(message.params),
          renderer: DataGrid.DataGridRenderers.codeBlockRenderer,
        },
        {columnId: 'response', value: '(pending)', renderer: DataGrid.DataGridRenderers.codeBlockRenderer},
        {
          columnId: 'timestamp',
          value: Date.now() - this.startTime,
          renderer: timeRenderer,
        },
        {columnId: 'elapsedTime', value: '(pending)'},
        {columnId: 'type', value: requestResponseIcon, title: 'sent'},
        {columnId: 'target', value: this.targetToString(sdkTarget)},
        {columnId: 'session', value: message.sessionId || ''},
      ],
      hidden: false,
    };
    this.requestTimeForId.set(message.id, Date.now());
    this.dataGridRowForId.set(message.id, newRow);
    this.dataGridIntegrator.update({
      ...this.dataGridIntegrator.data(),
      rows: this.dataGridIntegrator.data().rows.concat([newRow]),
    });
  }

  private async saveAsFile(): Promise<void> {
    const now = new Date();
    const fileName = 'ProtocolMonitor-' + Platform.DateUtilities.toISO8601Compact(now) + '.json' as
        Platform.DevToolsPath.RawPathString;
    const stream = new Bindings.FileUtils.FileOutputStream();

    const accepted = await stream.open(fileName);
    if (!accepted) {
      return;
    }

    void stream.write(JSON.stringify(this.messages, null, '  '));
    void stream.close();
  }
}

export class HistoryAutocompleteDataProvider {
  #maxHistorySize = 200;
  #commandHistory = new Set<string>();
  #protocolMethods =
      this.buildProtocolCommands(ProtocolClient.InspectorBackend.inspectorBackend.agentPrototypes.values());

  constructor(maxHistorySize?: number) {
    if (maxHistorySize !== undefined) {
      this.#maxHistorySize = maxHistorySize;
    }
  }

  buildTextPromptCompletions =
      async(expression: string, prefix: string, force?: boolean): Promise<UI.SuggestBox.Suggestions> => {
    if (!prefix && !force && expression) {
      return [];
    }
    const newestToOldest = [...this.#commandHistory].reverse();
    newestToOldest.push(...this.#protocolMethods);
    return newestToOldest.filter(cmd => cmd.startsWith(prefix)).map(text => ({
                                                                      text,
                                                                    }));
  };

  buildProtocolCommands(iterator: Iterable<ProtocolDomain>): Set<string> {
    const commands: Set<string> = new Set();
    for (const agentPrototype of iterator) {
      const domain = agentPrototype.domain;
      const prefix = 'invoke_';
      for (const func in agentPrototype) {
        if (func.startsWith(prefix) && func !== prefix) {
          const command = `${domain}.${func.substring(prefix.length)}`;  // Remove "invoke" prefix
          commands.add(command);
        }
      }
    }
    return commands;
  }

  addEntry(value: string): void {
    if (this.#commandHistory.has(value)) {
      this.#commandHistory.delete(value);
    }
    this.#commandHistory.add(value);
    if (this.#commandHistory.size > this.#maxHistorySize) {
      const earliestEntry = this.#commandHistory.values().next().value;
      this.#commandHistory.delete(earliestEntry);
    }
  }
}

export class InfoWidget extends UI.Widget.VBox {
  private readonly tabbedPane: UI.TabbedPane.TabbedPane;
  constructor() {
    super();
    this.tabbedPane = new UI.TabbedPane.TabbedPane();
    this.tabbedPane.appendTab('request', i18nString(UIStrings.request), new UI.Widget.Widget());
    this.tabbedPane.appendTab('response', i18nString(UIStrings.response), new UI.Widget.Widget());
    this.tabbedPane.show(this.contentElement);
    this.tabbedPane.selectTab('response');
    this.render(null);
  }

  render(data: {
    request: DataGrid.DataGridUtils.Cell|undefined,
    response: DataGrid.DataGridUtils.Cell|undefined,
    type: 'sent'|'received'|undefined,
  }|null): void {
    if (!data || !data.request || !data.response) {
      this.tabbedPane.changeTabView('request', new UI.EmptyWidget.EmptyWidget(i18nString(UIStrings.noMessageSelected)));
      this.tabbedPane.changeTabView(
          'response', new UI.EmptyWidget.EmptyWidget(i18nString(UIStrings.noMessageSelected)));
      return;
    }

    const requestEnabled = data && data.type && data.type === 'sent';
    this.tabbedPane.setTabEnabled('request', Boolean(requestEnabled));
    if (!requestEnabled) {
      this.tabbedPane.selectTab('response');
    }

    const requestParsed = JSON.parse(String(data.request.value) || 'null');
    this.tabbedPane.changeTabView('request', SourceFrame.JSONView.JSONView.createViewSync(requestParsed));
    const responseParsed =
        data.response.value === '(pending)' ? null : JSON.parse(String(data.response.value) || 'null');
    this.tabbedPane.changeTabView('response', SourceFrame.JSONView.JSONView.createViewSync(responseParsed));
  }
}

export function parseCommandInput(input: string): {command: string, parameters: unknown} {
  // If input cannot be parsed as json, we assume it's the command name
  // for a command without parameters. Otherwise, we expect an object
  // with "command"/"method"/"cmd" and "parameters"/"params"/"args"/"arguments" attributes.
  let json = null;
  try {
    json = JSON.parse(input);
  } catch (err) {
  }
  const command = json ? json.command || json.method || json.cmd : input;
  const parameters = json ? json.parameters || json.params || json.args || json.arguments : null;
  return {command, parameters};
}
