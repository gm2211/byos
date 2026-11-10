import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { AiPill } from '../dist/AiPill.js';
import { ModelEffortPicker } from '../dist/ModelEffortPicker.js';
import { AiQuickSettingsPanel } from '../dist/AiQuickSettingsPanel.js';
import { AiAccountSettings } from '../dist/AiAccountSettings.js';
import { AiConnectPanel } from '../dist/AiConnectPanel.js';
import { AiProviderPicker } from '../dist/AiProviderPicker.js';
import { DeviceCodeSignIn } from '../dist/DeviceCodeSignIn.js';
import { PasteCodeSignIn } from '../dist/PasteCodeSignIn.js';
import { SignInWithChatGPT } from '../dist/SignInWithChatGPT.js';

test('AiAccountSettings starts on Model, exposes provider switching, and mounts one settings pane', () => {
  const html = renderToStaticMarkup(createElement(AiAccountSettings, {
    providerName: 'Acme AI', onChangeProvider: () => undefined,
    modelSettings: createElement('p', null, 'Model controls'),
    accountSettings: createElement('p', null, 'Remember and disconnect'),
    toolsSettings: createElement('p', null, 'Tool access'),
  }));
  assert.match(html, /AI settings/);
  assert.match(html, /Change AI service/);
  assert.match(html, /aria-selected="true" aria-controls="_R_.*-panel"/);
  assert.match(html, /Model controls/);
  assert.doesNotMatch(html, /Remember and disconnect|Tool access/);
});

test('AiAccountSettings puts Account first and opens it while signed out', () => {
  const props = {
    providerName: 'Acme AI', onChangeProvider: () => undefined,
    modelSettings: createElement('p', null, 'Model controls'),
    accountSettings: createElement('p', null, 'Account controls'),
    toolsSettings: createElement('p', null, 'Tool access'),
  };
  const signedOut = renderToStaticMarkup(createElement(AiAccountSettings, { ...props, signedIn: false }));
  assert.deepEqual([...signedOut.matchAll(/role="tab"[^>]*>(?:<svg.*?<\/svg><span>)?([^<]+)</g)].map(match => match[1]), ['Account', 'Model', 'Tools']);
  assert.match(signedOut, /aria-selected="true"[^>]*>(?:<svg.*?<\/svg><span>)?Account</);
  assert.match(signedOut, /Account controls/);
  assert.doesNotMatch(signedOut, /Model controls/);
  const signedIn = renderToStaticMarkup(createElement(AiAccountSettings, { ...props, signedIn: true }));
  assert.deepEqual([...signedIn.matchAll(/role="tab"[^>]*>(?:<svg.*?<\/svg><span>)?([^<]+)</g)].map(match => match[1]), ['Model', 'Account', 'Tools']);
  assert.match(signedIn, /Model controls/);
});

test('AiAccountSettings shows a Reconnect banner that opens Account when no one-tap reconnect is bound', () => {
  const html = renderToStaticMarkup(createElement(AiAccountSettings, {
    providerName: 'Acme AI', expired: true, signedIn: true, onChangeProvider: () => undefined,
    modelSettings: createElement('p', null, 'Model controls'),
    accountSettings: createElement('p', null, 'Account controls'),
    recoveryAction: createElement('button', null, 'Recover'),
  }));
  assert.match(html, /role="status"[^>]*>.*Reconnect to use AI\./);
  assert.match(html, /class="byos-account-settings-reconnect"[^>]*>.*?Reconnect<\/button>/);
  assert.match(html, /Sign-in expired/);
  assert.match(html, /byos-account-settings-dot-expired/);
  assert.doesNotMatch(html, />Recover<\/button>/);
});

test('AiAccountSettings runs onReconnect from the banner and reports progress', () => {
  let reconnects = 0;
  const props = {
    providerName: 'Acme AI', expired: true, onChangeProvider: () => undefined, onReconnect: () => { reconnects += 1; },
    modelSettings: createElement('p', null, 'Model controls'),
    accountSettings: createElement('p', null, 'Account controls'),
  };
  const idle = renderToStaticMarkup(createElement(AiAccountSettings, props));
  assert.match(idle, /byos-account-settings-reconnect/);
  const busy = renderToStaticMarkup(createElement(AiAccountSettings, { ...props, reconnecting: true }));
  assert.match(busy, /class="byos-account-settings-reconnect" disabled="" aria-busy="true"[^>]*>.*?Connecting…<\/button>/);
  const healthy = renderToStaticMarkup(createElement(AiAccountSettings, { ...props, expired: false, signedIn: true }));
  assert.doesNotMatch(healthy, /byos-account-settings-reconnect/);
  assert.match(healthy, /Connected/);
  assert.equal(reconnects, 0);
});

test('AiAccountSettings labels the icon-only Change AI service button', () => {
  const html = renderToStaticMarkup(createElement(AiAccountSettings, {
    providerName: 'Acme AI', onChangeProvider: () => undefined, modelSettings: 'm', accountSettings: 'a',
  }));
  assert.match(html, /<button type="button" class="byos-account-settings-change" aria-label="Change AI service" title="Change AI service">/);
  assert.match(html, /byos-account-settings-avatar" aria-hidden="true">A</);
});

test('AiProviderPicker labels provider choices and marks the selected option', () => {
  const html = renderToStaticMarkup(createElement(AiProviderPicker, {
    providers: [{ id: 'a', name: 'Acme', badge: 'Plan' }, { id: 'b', name: 'Beta' }],
    selectedId: 'a', onSelect: () => undefined,
  }));
  assert.match(html, /aria-label="Choose an AI service"/);
  assert.match(html, /aria-pressed="true"/);
  assert.match(html, /Plan/);
  assert.match(html, /aria-pressed="false"/);
});

test('DeviceCodeSignIn exposes an optional focusable dialog heading', () => {
  const html = renderToStaticMarkup(createElement(DeviceCodeSignIn, {
    providerName: 'Acme', headingId: 'guided-start-heading', status: 'idle', device: null,
    connected: false, onStart: () => undefined, onCancel: () => undefined, onDisconnect: () => undefined,
  }));
  assert.match(html, /<h3 id="guided-start-heading" tabindex="-1">Connect your Acme account<\/h3>/);
  assert.doesNotMatch(html, /role="tablist"/);
});

test('compact DeviceCodeSignIn keeps pending actions visible and moves disclosure and account details to tabs', () => {
  const html = renderToStaticMarkup(createElement(DeviceCodeSignIn, {
    providerName: 'Acme', compact: true, status: 'pending', device: { deviceAuthId: 'demo', userCode: 'ABCD-EFGH', verificationUriComplete: 'https://example.test/approve' },
    connected: false, disclosure: 'Short privacy note', remember: { checked: false, onChange: () => undefined },
    privacyDetails: createElement('p', null, 'Full privacy details'), onStart: () => undefined, onCancel: () => undefined, onDisconnect: () => undefined,
  }));
  assert.match(html, /role="tablist"/);
  assert.match(html, /role="tab" aria-selected="true"/);
  assert.match(html, /ABCD-EFGH/);
  assert.match(html, /Continue at Acme/);
  assert.match(html, /Waiting for approval/);
  assert.match(html, /Cancel sign-in/);
  assert.doesNotMatch(html, /Short privacy note|Full privacy details|Remember on this browser/);
});

test('compact DeviceCodeSignIn shows initial disclosure and compact error recovery', () => {
  const initialHtml = renderToStaticMarkup(createElement(DeviceCodeSignIn, {
    providerName: 'Acme', compact: true, status: 'idle', device: null,
    connected: false, disclosure: 'Short privacy note', onStart: () => undefined, onCancel: () => undefined, onDisconnect: () => undefined,
  }));
  assert.match(initialHtml, /Short privacy note/);
  assert.match(initialHtml, /Connect Acme/);
  const errorHtml = renderToStaticMarkup(createElement(DeviceCodeSignIn, {
    providerName: 'Acme', compact: true, status: 'error', device: null, error: 'Code expired',
    connected: false, disclosure: 'Short privacy note', onStart: () => undefined, onCancel: () => undefined, onDisconnect: () => undefined,
  }));
  assert.doesNotMatch(errorHtml, /Short privacy note/);
  assert.match(errorHtml, /Code expired/);
  assert.match(errorHtml, /Try again/);
  assert.match(errorHtml, /Privacy/);
  assert.match(errorHtml, /Help/);
});

test('ChatGPT-branded device-code start and retry actions keep the device flow actionable in both layouts', () => {
  for (const compact of [false, true]) {
    const idle = renderToStaticMarkup(createElement(DeviceCodeSignIn, {
      providerName: 'ChatGPT', signInBrand: 'chatgpt', compact, status: 'idle', device: null,
      connected: false, onStart: () => undefined, onCancel: () => undefined, onDisconnect: () => undefined,
    }));
    assert.match(idle, /byos-chatgpt-identity-button byos-chatgpt-identity-black/);
    assert.match(idle, /<svg[^>]*viewBox="0 0 21 21"[^>]*aria-hidden="true"/);
    assert.match(idle, /<button[^>]*type="button"[^>]*>.*Connect ChatGPT/s);
    assert.doesNotMatch(idle, /disabled/);
    assert.doesNotMatch(idle, /Sign in with ChatGPT|Continue with ChatGPT/);

    const retry = renderToStaticMarkup(createElement(DeviceCodeSignIn, {
      providerName: 'ChatGPT', signInBrand: 'chatgpt', compact, status: 'error', device: null,
      error: 'Sign-in expired', connected: false,
      onStart: () => undefined, onCancel: () => undefined, onDisconnect: () => undefined,
    }));
    assert.match(retry, /<button[^>]*type="button"[^>]*>.*Try again/s);
    assert.doesNotMatch(retry, /disabled/);
    assert.match(retry, /byos-chatgpt-identity-button byos-chatgpt-identity-black/);
  }

  let started = 0;
  const rendered = DeviceCodeSignIn({
    providerName: 'ChatGPT', signInBrand: 'chatgpt', status: 'idle', device: null, connected: false,
    onStart: () => { started += 1; }, onCancel: () => undefined, onDisconnect: () => undefined,
  });
  const findStartButton = (node: unknown): { props: { onClick?: () => void } } | undefined => {
    if (Array.isArray(node)) return node.map(findStartButton).find(Boolean);
    if (!node || typeof node !== 'object') return undefined;
    const element = node as { type?: unknown; props?: { children?: unknown; onClick?: () => void } };
    if (element.type === 'button' && element.props?.onClick) return { props: element.props };
    if (typeof element.type === 'function') return findStartButton((element.type as (props: unknown) => unknown)(element.props));
    return findStartButton(element.props?.children);
  };
  findStartButton(rendered)?.props.onClick?.();
  assert.equal(started, 1);
});

test('compact DeviceCodeSignIn can hide redundant identity and reveal help only for pending and error states', () => {
  const base = {
    providerName: 'Acme', compact: true, showProviderIdentity: false, helpMode: 'contextual' as const,
    connected: false, onStart: () => undefined, onCancel: () => undefined, onDisconnect: () => undefined,
  };
  const idleHtml = renderToStaticMarkup(createElement(DeviceCodeSignIn, { ...base, status: 'idle', device: null }));
  assert.match(idleHtml, /role="tablist"[^>]*>[\s\S]*?<\/div>/);
  assert.equal((idleHtml.match(/role="tab"/g) ?? []).length, 2);
  assert.doesNotMatch(idleHtml, /class="byos-signin-provider"|Subscription|>Help<|Having trouble/);
  assert.match(idleHtml, /aria-selected="true" aria-controls=/);
  assert.match(idleHtml, /tabindex="-1"/);

  const pendingHtml = renderToStaticMarkup(createElement(DeviceCodeSignIn, {
    ...base, status: 'pending', device: { deviceAuthId: 'demo', userCode: 'ABCD-EFGH', verificationUriComplete: 'https://example.test/approve' },
  }));
  assert.equal((pendingHtml.match(/role="tab"/g) ?? []).length, 2);
  assert.match(pendingHtml, /<details class="byos-signin-help"><summary>Having trouble signing in\?<\/summary><p>Keep this tab open while you approve the code\.<\/p><\/details>/);

  const errorHtml = renderToStaticMarkup(createElement(DeviceCodeSignIn, { ...base, status: 'error', device: null, error: 'Code expired' }));
  assert.equal((errorHtml.match(/role="tab"/g) ?? []).length, 2);
  assert.match(errorHtml, /Code expired/);
  assert.match(errorHtml, /Try signing in again/);
  assert.doesNotMatch(errorHtml, /Keep this tab open/);
});

test('AiQuickSettingsPanel exposes the provider, settings action, expired notice, and recovery slot', () => {
  const html = renderToStaticMarkup(createElement(AiQuickSettingsPanel, {
    providerName: 'Acme AI', connection: 'expired', onOpenSettings: () => undefined,
    reconnectAction: createElement('button', null, 'Reconnect'), children: createElement('p', null, 'Model settings'),
  }));
  assert.match(html, /Acme AI/);
  assert.match(html, /All AI settings/);
  assert.match(html, /sign-in expired/);
  assert.match(html, /Reconnect/);
  assert.match(html, /Model settings/);
});

test('AiQuickSettingsPanel omits model content when the account is unavailable for model use', () => {
  for (const connection of ['disconnected', 'tools-only'] as const) {
    const html = renderToStaticMarkup(createElement(AiQuickSettingsPanel, {
      providerName: 'Acme AI', connection, onOpenSettings: () => undefined,
      children: createElement('p', null, 'Model settings'),
    }));
    assert.doesNotMatch(html, /Model settings/);
  }
});

test('ModelEffortPicker keeps default accessible names on its searchable controls', () => {
  const html = renderToStaticMarkup(createElement(ModelEffortPicker, {
    providerName: 'Acme',
    models: [{ value: 'model-1', label: 'Model One' }],
    model: 'model-1',
    onModelChange: () => undefined,
    efforts: [{ value: 'low', label: 'Low' }],
    effort: 'low',
    onEffortChange: () => undefined,
  }));

  assert.match(html, /role="combobox" aria-label="Model"/);
  assert.match(html, /role="combobox" aria-label="Effort"/);
});

test('ModelEffortPicker applies localized accessible names to native selects', () => {
  const html = renderToStaticMarkup(createElement(ModelEffortPicker, {
    providerName: 'Acme',
    models: [{ value: 'model-1', label: 'Modelo Uno' }],
    model: 'model-1',
    onModelChange: () => undefined,
    efforts: [],
    effort: '',
    onEffortChange: () => undefined,
    strings: { model: 'MODELO', modelAriaLabel: 'Seleccionar modelo', effort: 'NIVEL', effortAriaLabel: 'Seleccionar nivel' },
  }));

  assert.match(html, /aria-label="Seleccionar modelo"/);
  assert.match(html, /aria-label="Seleccionar nivel"/);
  assert.match(html, /<span>MODELO/);
  assert.match(html, /<span>NIVEL/);
});

test('AiPill keeps default setup and connected accessible names', () => {
  const setupHtml = renderToStaticMarkup(createElement(AiPill, {
    connected: false,
    label: 'gpt-6 · low',
    onSetup: () => undefined,
    children: () => null,
  }));
  const connectedHtml = renderToStaticMarkup(createElement(AiPill, {
    connected: true,
    label: 'gpt-6 · low',
    onSetup: () => undefined,
    children: () => null,
  }));

  assert.match(setupHtml, /aria-label="Set up AI"/);
  assert.match(connectedHtml, /aria-label="AI: gpt-6 · low\. Change model or effort"/);
});

test('AiPill applies localized accessible names in setup and connected states', () => {
  const setupHtml = renderToStaticMarkup(createElement(AiPill, {
    connected: false,
    label: 'modelo · bajo',
    setupAriaLabel: 'Configurar IA',
    onSetup: () => undefined,
    children: () => null,
  }));
  const connectedHtml = renderToStaticMarkup(createElement(AiPill, {
    connected: true,
    label: 'modelo · bajo',
    ariaLabel: 'Cambiar modelo y razonamiento',
    onSetup: () => undefined,
    children: () => null,
  }));

  assert.match(setupHtml, /aria-label="Configurar IA"/);
  assert.match(connectedHtml, /aria-label="Cambiar modelo y razonamiento"/);
});

test('translating visible picker labels also translates accessible names by default', () => {
  const html = renderToStaticMarkup(createElement(ModelEffortPicker, {
    providerName: 'Acme', models: [], model: '', onModelChange: () => undefined,
    efforts: [], effort: '', onEffortChange: () => undefined,
    strings: { model: 'Modelo', effort: 'Razonamiento' },
  }));
  assert.match(html, /aria-label="Modelo"/);
  assert.match(html, /aria-label="Razonamiento"/);
});


test('SignInWithChatGPT presents the approved route, identity-only disclosure, and disabled state accessibly', () => {
  const html = renderToStaticMarkup(createElement(SignInWithChatGPT, {
    href: '/auth/chatgpt/start', variant: 'white', status: 'idle',
    disclosure: 'ChatGPT identity signs in to this app only.',
  }));
  assert.match(html, /Continue with ChatGPT/);
  assert.match(html, /href="\/auth\/chatgpt\/start"/);
  assert.match(html, /<svg[^>]*viewBox="0 0 21 21"[^>]*aria-hidden="true"/);
  assert.doesNotMatch(html, /chatgpt-logo-(black|white)\.svg/);
  assert.match(html, /ChatGPT identity signs in to this app only/);
  assert.match(html, /aria-labelledby="byos-chatgpt-identity-/);

  const unavailable = renderToStaticMarkup(createElement(SignInWithChatGPT, {
    href: '/auth/chatgpt/start', status: 'unavailable', message: 'ChatGPT sign-in is not enabled.',
  }));
  assert.match(unavailable, /<button[^>]*disabled/);
  assert.match(unavailable, /role="status"/);
  assert.doesNotMatch(unavailable, /href="\/auth\/chatgpt\/start"/);

  for (const status of ['pending', 'success'] as const) {
    const inactive = renderToStaticMarkup(createElement(SignInWithChatGPT, { href: '/auth/chatgpt/start', status }));
    assert.match(inactive, /<button[^>]*disabled/);
    assert.doesNotMatch(inactive, /href="\/auth\/chatgpt\/start"/);
  }
});


test('kept settings panes are hidden and each tab controls its own panel', () => {
  const html = renderToStaticMarkup(createElement(AiAccountSettings, {
    providerName: 'Local', onChangeProvider: () => undefined, keepPanelsMounted: true,
    modelSettings: 'model pane', accountSettings: 'account pane', toolsSettings: 'tools pane',
  }));
  assert.match(html, /model pane/);
  assert.match(html, /account pane/);
  assert.match(html, /tools pane/);
  const panels = [...html.matchAll(/<div id="([^"]+)"[^>]*role="tabpanel"[^>]*>/g)];
  assert.equal(panels.length, 3);
  assert.equal(panels.filter(panel => panel[0].includes('hidden=""')).length, 2);
  for (const panel of panels) assert.ok(html.includes(`aria-controls="${panel[1]}"`));
});

const connectNoop = () => undefined;
function connectService(overrides: Record<string, unknown> = {}) {
  return {
    provider: { id: 'acme', displayName: 'Acme AI', signIn: [
      { kind: 'device-code', handshakeViaSite: true },
      { kind: 'api-key', hint: 'Create a key in the console.', setup: [{ label: 'Open the console', url: 'https://example.com/keys' }] },
      { kind: 'pkce', handshakeViaSite: false },
    ] },
    signedIn: false,
    modelSettings: createElement('p', null, 'Model controls'),
    deviceCode: { status: 'idle', device: null, onStart: connectNoop, onCancel: connectNoop },
    apiKey: { value: '', onChange: connectNoop, onSubmit: connectNoop, caption: 'Your key stays in this browser.' },
    ...overrides,
  };
}
const connectPanel = (props: Record<string, unknown>) => renderToStaticMarkup(createElement(AiConnectPanel, { onSelect: connectNoop, services: [connectService()], ...props } as never));

test('AiConnectPanel shows the heading and a provider picker until a service is selected', () => {
  const html = connectPanel({ intro: 'Pick one.', services: [connectService(), connectService({ provider: { id: 'beta', displayName: 'Beta', signIn: [] }, badge: 'API key only' })] });
  assert.match(html, /<h2[^>]*>Connect AI<\/h2>/);
  assert.match(html, /Pick one\./);
  assert.match(html, /byos-connect-picker/);
  assert.match(html, /API key only/);
  assert.doesNotMatch(html, /role="tablist"/);
  assert.doesNotMatch(html, /Back to/);
});

test('AiConnectPanel opens Account first while signed out and renders only declared, controlled methods in provider order', () => {
  const html = connectPanel({ selectedId: 'acme', preferences: createElement('p', null, 'Prefs') });
  assert.deepEqual([...html.matchAll(/role="tab"[^>]*>(?:<svg.*?<\/svg><span>)?([^<]+)</g)].map(match => match[1]).slice(0, 3), ['Account', 'Model', 'Preferences']);
  assert.match(html, /aria-selected="true"[^>]*>(?:<svg.*?<\/svg><span>)?Account</);
  assert.ok(html.indexOf("byos-signin") < html.indexOf("byos-connect-key"));
  assert.match(html, /byos-connect-or/);
  assert.match(html, /<input[^>]*type="password"/);
  assert.match(html, /<label[^>]*>API key<\/label>/);
  assert.match(html, /Create a key in the console\./);
  assert.match(html, /<a href="https:\/\/example\.com\/keys" target="_blank" rel="noopener noreferrer">Open the console<\/a>/);
  assert.match(html, /<button type="submit"[^>]*disabled=""[^>]*>Connect<\/button>/);
  assert.match(html, /Your key stays in this browser\./);
  // keepPanelsMounted: the Model pane is present but hidden, and offers no model list before connecting.
  assert.match(html, /hidden=""[^>]*>[^]*Connect to choose a model\./);
  assert.doesNotMatch(html, /Model controls/);
});

test('AiConnectPanel signed out shows one flat sign-in view: action, privacy sentence, remember, details', () => {
  const html = connectPanel({ selectedId: 'acme', services: [connectService({
    deviceCode: { status: 'idle', device: null, onStart: connectNoop, onCancel: connectNoop, signInBrand: 'chatgpt', disclosure: 'xAI handles sign-in.', privacyDetails: createElement('p', null, 'Long privacy'), remember: { checked: false, onChange: connectNoop } },
    remember: { checked: false, onChange: connectNoop },
  })] });
  // No nested Sign in / Privacy tabs, and no per-provider brand colour.
  assert.doesNotMatch(html, /byos-signin-compact-tabs|byos-chatgpt-identity/);
  const button = html.indexOf('byos-signin-primary');
  const sentence = html.indexOf('xAI handles sign-in.');
  const remember = html.indexOf('Stay signed in on this device');
  const details = html.indexOf('byos-signin-inline-privacy');
  assert.ok(button > 0 && button < sentence && sentence < remember && remember < details);
  assert.equal(html.match(/type="checkbox"/g)?.length, 1);
});

test('AiConnectPanel offers the remember checkbox below Connect for key and redirect methods', () => {
  const remember = { checked: false, onChange: connectNoop };
  const key = connectPanel({ selectedId: 'acme', services: [connectService({ deviceCode: undefined, remember })] });
  assert.ok(key.indexOf('byos-connect-primary') < key.indexOf('byos-connect-remember-check'));
  const pkce = connectPanel({ selectedId: 'acme', services: [connectService({ deviceCode: undefined, apiKey: undefined, pkce: { onStart: connectNoop, caption: 'Goes to Acme.' }, remember })] });
  assert.ok(pkce.indexOf('Goes to Acme.') < pkce.indexOf('byos-connect-remember-check'));
});

test('AiConnectPanel never renders a declared method that has no controller', () => {
  const html = connectPanel({ selectedId: 'acme', services: [connectService({ deviceCode: undefined, apiKey: undefined })] });
  assert.doesNotMatch(html, /byos-signin|byos-connect-key|byos-connect-or/);
  const pkce = connectPanel({ selectedId: 'acme', services: [connectService({ deviceCode: undefined, apiKey: undefined, pkce: { onStart: connectNoop, error: 'Popup blocked' } })] });
  assert.match(pkce, />Sign in with Acme AI<\/button>/);
  assert.match(pkce, /role="alert">Popup blocked/);
});

test('AiConnectPanel signed in opens Model and offers the remember switch and sign out in Account', () => {
  const services = [connectService({ signedIn: true, remember: { checked: true, onChange: connectNoop }, onSignOut: connectNoop })];
  const html = connectPanel({ selectedId: 'acme', services });
  assert.deepEqual([...html.matchAll(/role="tab"[^>]*>(?:<svg.*?<\/svg><span>)?([^<]+)</g)].map(match => match[1]), ['Model', 'Account']);
  assert.match(html, /aria-selected="true"[^>]*>(?:<svg.*?<\/svg><span>)?Model</);
  assert.match(html, /Connected to Acme AI/);
  assert.match(html, /role="switch" aria-checked="true"/);
  assert.match(html, /Stay signed in on this device/);
  assert.match(html, />Sign out of Acme AI<\/button>/);
  assert.match(html, /Change AI service/);
});

test('AiConnectPanel strings are overridable', () => {
  const html = connectPanel({ strings: { heading: 'Conectar IA', pickerLabel: 'Elige' } });
  assert.match(html, /Conectar IA/);
  assert.match(html, /aria-label="Elige"/);
});

const pasteProps = (overrides: Record<string, unknown> = {}) => ({
  providerName: 'Claude', status: 'idle', code: '', onCodeChange: connectNoop, onStart: connectNoop, onSubmit: connectNoop, onCancel: connectNoop, ...overrides,
});
const paste = (overrides: Record<string, unknown> = {}) => renderToStaticMarkup(createElement(PasteCodeSignIn, pasteProps(overrides) as never));

test('PasteCodeSignIn idle shows a start button, the disclosure, and a disabled unavailable state', () => {
  const idle = paste({ disclosure: 'The host passes your sign-in to Anthropic and never stores it.' });
  assert.match(idle, /<h3[^>]*>Sign in with Claude<\/h3>/);
  assert.match(idle, />Sign in with Claude<\/span>/);
  assert.match(idle, /The host passes your sign-in to Anthropic/);
  assert.doesNotMatch(idle, /<input/);
  const unavailable = paste({ available: false });
  assert.match(unavailable, /role="status">Claude sign-in is unavailable right now\./);
  assert.match(unavailable, /<button[^>]*disabled=""[^>]*><span>Sign-in unavailable<\/span>/);
});

test('PasteCodeSignIn awaiting-code has a labelled password input, a hint, and an alert for errors', () => {
  const html = paste({ status: 'awaiting-code', code: 'abc#def', error: 'That code did not match.' });
  const input = /<input[^>]*id="([^"]+)"[^>]*>/.exec(html);
  assert.ok(input);
  assert.match(input[0], /type="password"/);
  assert.match(input[0], /autoComplete="off"|autocomplete="off"/i);
  assert.match(input[0], /value="abc#def"/);
  assert.match(html, new RegExp(`<label[^>]*for="${input[1]}"[^>]*>Paste the code Claude shows you</label>`));
  assert.match(html, /After you approve, Claude shows a code\. Copy all of it and paste it here\./);
  assert.match(input[0], /aria-describedby="[^"]*-hint[^"]*-error"/);
  assert.match(html, /role="alert">That code did not match\./);
  assert.match(html, /<button[^>]*type="submit"[^>]*>Connect<\/button>/);
  assert.match(html, />Cancel sign-in<\/button>/);
});

test('PasteCodeSignIn disables submit while empty or exchanging and offers a reopen after an error', () => {
  assert.match(paste({ status: 'awaiting-code', code: '  ' }), /<button[^>]*type="submit"[^>]*disabled=""/);
  const exchanging = paste({ status: 'exchanging', code: 'abc' });
  assert.match(exchanging, /<input[^>]*disabled=""/);
  assert.match(exchanging, /aria-busy="true"[^>]*>Completing sign-in…<\/button>|disabled=""[^>]*aria-busy="true"/);
  const failed = paste({ status: 'error', code: 'abc', error: 'Try again.' });
  assert.match(failed, /Open Claude again/);
  assert.match(failed, /aria-invalid="true"/);
  assert.doesNotMatch(paste({ status: 'awaiting-code', code: 'abc' }), /Open Claude again/);
});

test('PasteCodeSignIn renders remember and privacy details and overridable strings', () => {
  const html = paste({ remember: { checked: true, onChange: connectNoop }, privacyDetails: createElement('p', null, 'Details here'), strings: { connectTitle: 'Conectar', connectButton: 'Entrar' } });
  assert.match(html, /type="checkbox"[^>]*checked=""/);
  assert.match(html, /How sign-in and privacy work/);
  assert.match(html, /Details here/);
  assert.match(html, /<h3[^>]*>Conectar<\/h3>/);
  assert.match(html, />Entrar<\/span>/);
});

test('AiConnectPanel renders PasteCodeSignIn only for a paste-code pkce method with a pasteCode controller', () => {
  const claudeLike = (overrides: Record<string, unknown> = {}) => connectService({
    provider: { id: 'claude', displayName: 'Claude', signIn: [{ kind: 'pkce', handshakeViaSite: true, completion: 'paste-code' }, { kind: 'api-key', hint: 'A key.' }] },
    deviceCode: undefined,
    ...overrides,
  });
  const pasteCode = { status: 'awaiting-code', code: '', onCodeChange: connectNoop, onStart: connectNoop, onSubmit: connectNoop, onCancel: connectNoop };
  const html = connectPanel({ selectedId: 'claude', services: [claudeLike({ pasteCode })] });
  assert.match(html, /byos-signin-paste/);
  assert.match(html, /Paste the code Claude shows you/);
  assert.ok(html.indexOf('byos-signin-paste') < html.indexOf('byos-connect-key'));
  const without = connectPanel({ selectedId: 'claude', services: [claudeLike({ apiKey: undefined })] });
  assert.doesNotMatch(without, /byos-signin-paste/);
  // A plain pkce controller does not stand in for a paste-code method.
  const plainPkce = connectPanel({ selectedId: 'claude', services: [claudeLike({ apiKey: undefined, pkce: { onStart: connectNoop } })] });
  assert.doesNotMatch(plainPkce, /Sign in with Claude<\/button>/);
});

test('AiConnectPanel binds the expired banner to redirect sign-in by default', () => {
  const services = [connectService({ signedIn: true, expired: true, pkce: { onStart: connectNoop, busy: true } })];
  const html = connectPanel({ selectedId: 'acme', services });
  assert.match(html, /class="byos-account-settings-reconnect" disabled="" aria-busy="true"/);
  assert.match(html, /Connecting…<\/button>/);
});
