import { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import {
  AiPill,
  AiQuickSettingsPanel,
  defaultDeviceCodeStrings,
  DeviceCodeSignIn,
  ModelEffortPicker,
  type DeviceCodeSignInStrings,
  type ModelEffortPickerStrings,
} from '@byos/react';
import '@byos/react/styles.css';

type DemoState = 'idle' | 'preparing' | 'pending' | 'exchanging' | 'success' | 'error';
type Locale = 'en' | 'es';
type Theme = 'indigo' | 'moss' | 'plum';

const demoDevice = {
  deviceAuthId: 'preview-only',
  userCode: 'ABCD-EFGH',
  verificationUriComplete: '#approval-demo',
};
const demoModels = [
  { value: 'sample-small', label: 'Sample Small', meta: 'fast' },
  { value: 'sample-balanced', label: 'Sample Balanced', meta: 'general' },
];

const stateNames: Record<Locale, Record<DemoState, string>> = {
  en: { idle: 'Idle', preparing: 'Preparing', pending: 'Waiting for approval', exchanging: 'Completing sign-in', success: 'Connected', error: 'Error' },
  es: { idle: 'Inactivo', preparing: 'Preparando', pending: 'Esperando aprobación', exchanging: 'Finalizando acceso', success: 'Conectado', error: 'Error' },
};

function spanishSignInStrings(providerName: string): Partial<DeviceCodeSignInStrings> {
  return {
    planName: 'Suscripción',
    connectTitle: `Conecta tu cuenta de ${providerName}`,
    connectBody: 'Usa la suscripción que ya pagas.',
    connectedTitle: 'Conexión lista',
    connectedBody: 'La cuenta queda guardada en este navegador.',
    connectedUnavailableBody: 'La cuenta está guardada en este navegador. Ahora no está disponible.',
    preparingTitle: 'Preparando el acceso',
    preparingBody: 'Solicitando un código de prueba…',
    codeTitle: `Código de prueba para ${providerName}`,
    codeBody: 'Esta vista previa no abre un servicio externo.',
    exchangingTitle: 'Finalizando el acceso',
    exchangingBody: 'Comprobando la autorización…',
    unavailable: 'El acceso no está disponible ahora.',
    connectButton: `Conectar ${providerName}`,
    retryButton: 'Intentar de nuevo',
    unavailableButton: 'Acceso no disponible',
    continueButton: 'Ver enlace de prueba',
    codeLabel: 'CÓDIGO DE PRUEBA',
    copied: 'Copiado',
    copyFailed: 'No se pudo copiar',
    copyCode: 'Copiar código de prueba',
    waiting: 'Esperando aprobación de prueba…',
    starting: 'Iniciando vista previa…',
    completing: 'Finalizando vista previa…',
    cancel: 'Cancelar vista previa',
    connectedStatus: `${providerName}: conexión de prueba`,
    disconnect: 'Desconectar vista previa',
    troubleSummary: '¿Necesitas ayuda?',
    troubleBody: 'La vista previa no envía solicitudes.',
    remember: 'Recordar en este navegador',
    privacySummary: 'Privacidad de esta vista previa',
  };
}

function App() {
  const [demoState, setDemoState] = useState<DemoState>('idle');
  const [locale, setLocale] = useState<Locale>('en');
  const [theme, setTheme] = useState<Theme>('indigo');
  const [remember, setRemember] = useState(false);
  const [model, setModel] = useState('sample-small');
  const [effort, setEffort] = useState('low');
  const providerName = 'Sample AI';
  const connected = demoState === 'success';
  useEffect(() => { document.documentElement.lang = locale; }, [locale]);
  const status = demoState === 'error' ? 'error' : demoState === 'exchanging' ? 'exchanging' : demoState === 'idle' || connected ? 'idle' : 'pending';
  const device = demoState === 'pending' ? demoDevice : null;
  const englishStrings = defaultDeviceCodeStrings(providerName);
  const signInStrings = locale === 'es' ? spanishSignInStrings(providerName) : englishStrings;
  const pickerStrings: Partial<ModelEffortPickerStrings> = locale === 'es' ? {
    model: 'MODELO',
    effort: 'RAZONAMIENTO',
    modelAriaLabel: 'Modelo',
    effortAriaLabel: 'Nivel de razonamiento',
    effortFrom: provider => `opciones de ${provider}`,
    providerDefault: 'Predeterminado del proveedor',
    noEffort: provider => `${provider} elige el nivel automáticamente para este modelo.`,
  } : {};
  const overlayRoot = document.getElementById('byos-overlay-root') ?? undefined;
  const languageLabel = locale === 'es' ? 'Idioma' : 'Language';
  const stateLabel = locale === 'es' ? 'Estado de acceso' : 'Sign-in preview';
  const themeLabel = locale === 'es' ? 'Color' : 'Accent';
  const previewTitle = locale === 'es' ? 'Acceso de suscripción' : 'Subscription sign-in';
  const selectedModel = demoModels.find(option => option.value === model)?.label ?? model;
  const selectedEffort = locale === 'es' ? (effort === 'low' ? 'Bajo' : 'Máximo') : (effort === 'low' ? 'Low' : 'Max');
  const connectedLabel = `${selectedModel} · ${selectedEffort}`;

  return <div className={`demo-app theme-${theme}`}>
    <div className="demo-page">
      <header className="masthead">
        <div className="wordmark"><span className="wordmark-mark" aria-hidden="true">B</span><span>BYOS / React</span></div>
        <span className="masthead-note">{locale === 'es' ? 'Componentes listos para adaptar' : 'A small, runnable customization example'}</span>
      </header>

      <main>
        <section className="intro" aria-labelledby="page-title">
          <div>
            <p className="eyebrow">@byos/react · preview</p>
            <h1 id="page-title">{locale === 'es' ? 'Tu marca, tus estados, tus etiquetas.' : 'Your brand. Your states. Your labels.'}</h1>
          </div>
          <p className="intro-copy">{locale === 'es' ? 'Prueba la interfaz con datos sintéticos. No se conecta a ningún proveedor.' : 'Try the component states with sample data. This page never contacts a provider.'}</p>
        </section>

        <section className="controls" aria-label={locale === 'es' ? 'Controles de vista previa' : 'Preview controls'}>
          <div className="control">
            <label htmlFor="demo-state">{stateLabel}</label>
            <select id="demo-state" value={demoState} onChange={event => setDemoState(event.target.value as DemoState)}>
              {(Object.keys(stateNames[locale]) as DemoState[]).map(value => <option key={value} value={value}>{stateNames[locale][value]}</option>)}
            </select>
          </div>
          <div className="control">
            <label htmlFor="demo-language">{languageLabel}</label>
            <select id="demo-language" value={locale} onChange={event => setLocale(event.target.value as Locale)}>
              <option value="en">English</option>
              <option value="es">Español</option>
            </select>
          </div>
          <div className="control">
            <label htmlFor="demo-theme">{themeLabel}</label>
            <select id="demo-theme" value={theme} onChange={event => setTheme(event.target.value as Theme)}>
              <option value="indigo">Indigo</option>
              <option value="moss">Moss</option>
              <option value="plum">Plum</option>
            </select>
          </div>
        </section>

        <section className="showcase" aria-label={locale === 'es' ? 'Componentes BYOS' : 'BYOS components'}>
          <article className="card signin-card">
            <div className="card-top">
              <p className="card-kicker">{previewTitle}</p>
              <span className="sample-badge">{locale === 'es' ? 'Solo datos de prueba' : 'Synthetic data only'}</span>
            </div>
            <DeviceCodeSignIn
              providerName={providerName}
              status={status}
              device={device}
              error={demoState === 'error' ? (locale === 'es' ? 'Error de prueba. Inténtalo de nuevo.' : 'Preview error. Try again.') : undefined}
              connected={connected}
              available
              onStart={() => setDemoState('preparing')}
              onCancel={() => setDemoState('idle')}
              onDisconnect={() => setDemoState('idle')}
              remember={{ checked: remember, onChange: setRemember }}
              disclosure={locale === 'es' ? 'Código ficticio. No se envían credenciales ni solicitudes.' : 'Placeholder code only. No credentials or provider requests.'}
              privacyDetails={<p>{locale === 'es' ? 'Esta vista solo muestra la interfaz de ejemplo.' : 'This demo only renders the sample interface.'}</p>}
              strings={signInStrings}
              linkTarget="_self"
            />
          </article>

          <aside className="card settings-card" aria-labelledby="settings-title">
            <div className="card-top">
              <h2 id="settings-title">{locale === 'es' ? 'Ajustes rápidos' : 'Quick settings'}</h2>
              <span className="card-kicker">{locale === 'es' ? 'Muestra' : 'Preview'}</span>
            </div>
            <p className="settings-copy">{locale === 'es' ? 'Abre el selector desde el botón compacto.' : 'Open the model and effort picker from the compact status control.'}</p>
            <div className="pill-line">
              <span className="pill-caption">{connected ? (locale === 'es' ? 'Cuenta de muestra conectada' : 'Sample account connected') : (locale === 'es' ? 'Elige “Conectado” para abrir ajustes' : 'Choose “Connected” above to open settings')}</span>
              <AiPill
                connected={connected}
                label={connectedLabel}
                setupLabel={locale === 'es' ? 'Configurar' : 'Set up'}
                setupAriaLabel={locale === 'es' ? 'Mostrar estado conectado de prueba' : 'Show the connected preview state'}
                ariaLabel={locale === 'es' ? `IA: ${connectedLabel}. Cambiar modelo o razonamiento` : `AI: ${connectedLabel}. Change model or effort`}
                prefix={locale === 'es' ? 'IA' : 'AI'}
                popoverLabel={locale === 'es' ? 'Ajustes rápidos de IA' : 'Quick AI settings'}
                portalContainer={overlayRoot}
                onSetup={() => setDemoState('success')}
              >
                {close => <>
                  <p className="demo-popover-title">{locale === 'es' ? 'Preferencias de prueba' : 'Sample preferences'}</p>
                  <ModelEffortPicker
                    providerName={providerName}
                    models={demoModels}
                    model={model}
                    onModelChange={setModel}
                    efforts={[{ value: 'low', label: locale === 'es' ? 'Bajo' : 'Low' }, { value: 'max', label: locale === 'es' ? 'Máximo' : 'Max' }]}
                    effort={effort}
                    onEffortChange={setEffort}
                    strings={pickerStrings}
                    portalContainer={overlayRoot}
                  />
                  <div className="demo-popover-footer"><button type="button" className="demo-close" onClick={close}>{locale === 'es' ? 'Listo' : 'Done'}</button></div>
                </>}
              </AiPill>
            </div>
            <p className="privacy-note">{locale === 'es' ? 'Los selectores usan opciones ficticias. No se realizan llamadas a modelos.' : 'Picker options are fictional. No model calls run in this example.'}</p>
            <div className="quick-panel-demo">
              <AiQuickSettingsPanel providerName={providerName} connection={connected ? 'connected' : 'disconnected'} onOpenSettings={() => setDemoState('success')} strings={locale === 'es' ? { allSettings: 'Todos los ajustes', disconnected: provider => `${provider} no está conectado. Conéctalo en Ajustes de IA para elegir un modelo.` } : undefined}>
                <ModelEffortPicker providerName={providerName} models={demoModels} model={model} onModelChange={setModel} efforts={[{ value: 'low', label: 'Low' }, { value: 'max', label: 'Max' }]} effort={effort} onEffortChange={setEffort} portalContainer={overlayRoot} />
              </AiQuickSettingsPanel>
            </div>
          </aside>
        </section>
      </main>

      <footer>{locale === 'es' ? 'Personaliza tokens CSS, textos, estados y la raíz del portal en tu aplicación.' : 'Customize CSS tokens, strings, state bindings, and the portal root in your app.'}</footer>
    </div>
    <div id="byos-overlay-root" />
  </div>;
}

createRoot(document.getElementById('root')!).render(<App />);
