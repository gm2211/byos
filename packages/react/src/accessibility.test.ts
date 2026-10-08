import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { AiPill } from '../dist/AiPill.js';
import { ModelEffortPicker } from '../dist/ModelEffortPicker.js';
import { AiQuickSettingsPanel } from '../dist/AiQuickSettingsPanel.js';

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
