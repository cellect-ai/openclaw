import { consume } from "@lit/context";
// Controller for the curated Talk settings page. Owns the talk.catalog read
// that feeds the provider/model/voice pickers; all writes go through the shared
// config form draft so the embedded schema editor below stays in sync.
import type { TalkCatalogResult } from "@openclaw/gateway-protocol";
import { html, type TemplateResult } from "lit";
import { property, state } from "lit/decorators.js";
import { applicationContext, type ApplicationContext } from "../../app/context.ts";
import { isGatewayMethodAdvertised } from "../../lib/gateway-methods.ts";
import { OpenClawLightDomElement } from "../../lit/openclaw-element.ts";
import { SubscriptionsController } from "../../lit/subscriptions-controller.ts";
import {
  isTalkGptLiveModel,
  resolveTalkRealtimeSelection,
  talkProviderRejectsTransport,
} from "./talk-schema.ts";
import { TalkVoicePreview } from "./talk-voice-preview.ts";
import { voiceWakeOwner } from "./talk-voice-wake-owner.ts";
import {
  effectiveTalkValues,
  renderTalk,
  selectedTalkProviderOption,
  talkProviderConfigKeys,
  type TalkCatalogState,
  type TalkRealtimeProviderOption,
} from "./talk.ts";

type GatewayClient = NonNullable<ApplicationContext["gateway"]["snapshot"]["client"]>;
type ConfigSnapshot = ApplicationContext["runtimeConfig"]["state"]["configSnapshot"];

function configRevisionToken(snapshot: ConfigSnapshot): string | null {
  return snapshot?.configRevisionHash ?? snapshot?.hash ?? null;
}

/**
 * One gateway connection phase; object identity is the request generation so a
 * catalog load that started under an older phase is dropped, never applied
 * (same shape as memory-page.ts).
 */
type CatalogConnection = {
  gatewayUrl: string;
  client: GatewayClient | null;
  connected: boolean;
  voiceWake: boolean;
  scope: CatalogScope | null;
};

type ModelDefaultResetIntent = {
  gatewayUrl: string;
  configRevision: string | null;
};

type CatalogScope = { gatewayUrl: string; connectionRevision: number };
type ReadyTalkCatalog = Extract<TalkCatalogState, { kind: "ready" }>;

type TalkPageProps = {
  configObject: Record<string, unknown>;
  mutationDisabled: boolean;
  /** Builds the embedded schema editor over the full `talk` section. */
  buildEditor: () => TemplateResult;
};

function toProviderOption(
  provider: TalkCatalogResult["realtime"]["providers"][number],
): TalkRealtimeProviderOption {
  return {
    id: provider.id,
    label: provider.label,
    configured: provider.configured,
    aliases: provider.aliases ?? [],
    models: provider.models ?? [],
    voices: provider.voices ?? [],
    activeVoices: provider.activeVoices,
    activeVoiceSelectionPolicy: provider.activeVoiceSelectionPolicy,
    voicesByModel: provider.voicesByModel,
    transports: provider.transports ?? [],
    defaultModel: provider.defaultModel ?? null,
  };
}

/** Transports whose sessions are client-owned (`talk.client.create`). */
const TALK_CLIENT_OWNED_TRANSPORTS = new Set(["webrtc", "provider-websocket"]);

function gptLiveRejectsTransport(model: string | null, transport: string): boolean {
  return isTalkGptLiveModel(model) && transport === "provider-websocket";
}

class TalkSettingsPage extends OpenClawLightDomElement {
  @consume({ context: applicationContext, subscribe: true })
  private context!: ApplicationContext;

  @property({ attribute: false }) configObject: Record<string, unknown> = {};
  @property({ type: Boolean }) mutationDisabled = false;
  @property({ attribute: false }) buildEditor: TalkPageProps["buildEditor"] = () => html``;

  @state() private catalog: TalkCatalogState = { kind: "unavailable", reason: "disconnected" };
  @state() private modelDefaultResetIntent: ModelDefaultResetIntent | null = null;

  private connection: CatalogConnection | null = null;
  private readonly voicePreview = new TalkVoicePreview(() => this.requestUpdate());
  private catalogRequestId = 0;
  private lastReadyCatalog: ReadyTalkCatalog | null = null;
  private lastReadyCatalogScope: CatalogScope | null = null;
  /** `undefined` = baseline not yet observed; `null` = no public revision token. */
  private lastCatalogConfigRevision: string | null | undefined;
  private readonly subscriptions = new SubscriptionsController(this)
    .watch(
      () => (this.context?.gateway ? voiceWakeOwner(this.context.gateway) : undefined),
      (owner, notify) => owner.subscribe(notify),
    )
    .watch(
      () => this.context?.nativeDeviceSettings,
      (capability, notify) => capability.subscribe(notify),
    )
    .watch(
      () => this.context?.gateway,
      (gateway, notify) => gateway.subscribe(notify),
      (gateway) =>
        this.syncCatalog(
          gateway.connection.gatewayUrl,
          gateway.snapshot.client,
          gateway.snapshot.phase === "connected",
          isGatewayMethodAdvertised(gateway.snapshot, "voicewake.get") === true &&
            isGatewayMethodAdvertised(gateway.snapshot, "voicewake.set") === true,
        ),
    )
    .watch(
      () => this.context?.runtimeConfig,
      (runtimeConfig, notify) => runtimeConfig.subscribe(notify),
      (runtimeConfig) => this.refreshCatalogOnConfigChange(runtimeConfig.state),
    );

  // Provider credential readiness can change outside the config editor without
  // advancing the config hash, so window focus refreshes the catalog.
  private readonly refreshOnFocus = () => {
    const connection = this.connection;
    if (connection?.client && connection.connected) {
      void this.loadCatalog(connection.client, connection);
    }
  };

  override connectedCallback() {
    super.connectedCallback();
    window.addEventListener("focus", this.refreshOnFocus);
  }

  override disconnectedCallback() {
    this.voicePreview.stop();
    window.removeEventListener("focus", this.refreshOnFocus);
    voiceWakeOwner(this.context.gateway).flush();
    this.subscriptions.clear();
    this.connection = null;
    this.catalog = { kind: "unavailable", reason: "disconnected" };
    super.disconnectedCallback();
  }

  private syncCatalog(
    gatewayUrl: string,
    client: GatewayClient | null,
    connected: boolean,
    voiceWake: boolean,
  ) {
    if (this.modelDefaultResetIntent && this.modelDefaultResetIntent.gatewayUrl !== gatewayUrl) {
      this.modelDefaultResetIntent = null;
    }
    const scope = this.readCatalogScope();
    // connecting -> connected keeps the same client object; keying only on the
    // client would leave a page mounted mid-handshake without a catalog.
    if (
      this.connection?.gatewayUrl === gatewayUrl &&
      this.connection.client === client &&
      this.connection.connected === connected &&
      this.connection.voiceWake === voiceWake &&
      sameCatalogScope(this.connection.scope, scope)
    ) {
      return;
    }
    this.voicePreview.stop();
    const connection: CatalogConnection = { gatewayUrl, client, connected, voiceWake, scope };
    this.connection = connection;
    const cachedCatalog = this.cachedCatalog(scope);
    if (!client || !connected) {
      this.catalog = cachedCatalog ?? { kind: "unavailable", reason: "disconnected" };
      return;
    }
    this.catalog = cachedCatalog ?? { kind: "loading" };
    void this.loadCatalog(client, connection);
  }

  private async loadCatalog(client: GatewayClient, connection: CatalogConnection) {
    // Initial load, config-hash refresh, and focus refresh can overlap on the
    // same connection; only the newest request may write the catalog, or a
    // slow older response would overwrite a fresher one.
    const requestId = ++this.catalogRequestId;
    const cachedCatalog = this.cachedCatalog(connection.scope);
    if (cachedCatalog) {
      this.catalog = cachedCatalog;
    }
    try {
      const result = await client.request<TalkCatalogResult>("talk.catalog", {});
      const applied = this.applyCatalog(connection, requestId, {
        kind: "ready",
        ready: result.realtime.ready === true,
        activeProvider: result.realtime.activeProvider ?? null,
        providers: result.realtime.providers.map(toProviderOption),
      });
      if (applied) {
        this.acknowledgeModelDefaultReset(connection);
      }
    } catch {
      // The catalog only powers the pickers; the page still renders the raw
      // configured values when it cannot be read. Keep same-Gateway choices
      // visible but read-only instead of making a transient failure erase them.
      this.applyCatalog(
        connection,
        requestId,
        this.cachedCatalog(connection.scope) ?? { kind: "unavailable", reason: "request-failed" },
      );
    }
  }

  private applyCatalog(
    connection: CatalogConnection,
    requestId: number,
    catalog: TalkCatalogState,
  ): boolean {
    if (
      !this.isConnected ||
      this.connection !== connection ||
      this.catalogRequestId !== requestId ||
      !sameCatalogScope(this.readCatalogScope(), connection.scope)
    ) {
      return false;
    }
    this.catalog = catalog;
    if (catalog.kind === "ready") {
      this.lastReadyCatalog = { ...catalog, stale: false };
      this.lastReadyCatalogScope = connection.scope;
    }
    return true;
  }

  private acknowledgeModelDefaultReset(connection: CatalogConnection) {
    const intent = this.modelDefaultResetIntent;
    const configRevision = this.lastCatalogConfigRevision;
    // Without a public revision token, a ready catalog cannot prove the reset
    // was applied; retain provider-default metadata until an authoritative ack.
    if (configRevision == null) {
      return;
    }
    if (intent?.gatewayUrl === connection.gatewayUrl && intent.configRevision !== configRevision) {
      this.modelDefaultResetIntent = null;
    }
  }

  private readCatalogScope(): CatalogScope | null {
    const gateway = this.context?.gateway;
    const gatewayUrl = gateway?.connection?.gatewayUrl;
    const connectionRevision = gateway?.connectionRevision;
    return gatewayUrl && typeof connectionRevision === "number"
      ? { gatewayUrl, connectionRevision }
      : null;
  }

  private cachedCatalog(scope: CatalogScope | null): ReadyTalkCatalog | null {
    return sameCatalogGateway(this.lastReadyCatalogScope, scope) && this.lastReadyCatalog
      ? { ...this.lastReadyCatalog, stale: true }
      : null;
  }

  /**
   * Readiness can change on the same connection when a config write lands (the
   * gateway may hot-apply talk config without dropping the socket), so the
   * catalog re-reads whenever the public config revision advances. The revision
   * is the durable ack signal; transient saving flags can be skipped entirely
   * by a fast save.
   */
  private refreshCatalogOnConfigChange(configState: ApplicationContext["runtimeConfig"]["state"]) {
    const configRevision = configRevisionToken(configState.configSnapshot);
    if (this.lastCatalogConfigRevision === undefined) {
      this.lastCatalogConfigRevision = configRevision;
      return;
    }
    if (configRevision === null || configRevision === this.lastCatalogConfigRevision) {
      return;
    }
    this.lastCatalogConfigRevision = configRevision;
    const connection = this.connection;
    if (connection?.client && connection.connected) {
      void this.loadCatalog(connection.client, connection);
    }
  }

  /**
   * The pickers advertise "Provider default", so a null pick must clear every
   * key that could keep supplying the old value: the top-level override, the
   * legacy speakerVoiceId spelling, and the selected provider's own entry
   * (matched by configured spelling, canonical id, and aliases). Removing only
   * the top-level key would make Default a no-op over provider-level config.
   */
  private changeModel(model: string | null) {
    if (this.mutationDisabled) {
      return;
    }
    this.voicePreview.stop();
    const runtimeConfig = this.context.runtimeConfig;
    if (model !== null) {
      this.modelDefaultResetIntent = null;
      runtimeConfig.patchForm(["talk", "realtime", "model"], model);
      const selection = this.liveSelection();
      const transport = selection.transport;
      const provider = selectedTalkProviderOption(this.catalog, selection);
      const rejectsTransport =
        transport !== null &&
        (gptLiveRejectsTransport(model, transport) ||
          talkProviderRejectsTransport(provider?.transports, transport));
      // Preserve configured transports unless the selected provider positively
      // advertises that it cannot serve them.
      if (isTalkGptLiveModel(model) && rejectsTransport) {
        runtimeConfig.removeFormValue(["talk", "realtime", "transport"]);
      } else if (
        provider?.id === "openai" &&
        isTalkGptLiveModel(model) &&
        transport === "gateway-relay" &&
        selection.consultRouting === "force-agent-consult"
      ) {
        runtimeConfig.removeFormValue(["talk", "realtime", "consultRouting"]);
      }
      return;
    }
    this.modelDefaultResetIntent = {
      gatewayUrl: this.context.gateway.connection.gatewayUrl,
      configRevision: configRevisionToken(runtimeConfig.state.configSnapshot),
    };
    runtimeConfig.removeFormValue(["talk", "realtime", "model"]);
    for (const key of this.selectedProviderConfigKeys()) {
      runtimeConfig.removeFormValue(["talk", "realtime", "providers", key, "model"]);
    }
  }

  private changeVoice(voice: string | null) {
    if (this.mutationDisabled) {
      return;
    }
    const runtimeConfig = this.context.runtimeConfig;
    if (voice !== null) {
      runtimeConfig.patchForm(["talk", "realtime", "speakerVoice"], voice);
      return;
    }
    runtimeConfig.removeFormValue(["talk", "realtime", "speakerVoice"]);
    runtimeConfig.removeFormValue(["talk", "realtime", "speakerVoiceId"]);
    for (const key of this.selectedProviderConfigKeys()) {
      runtimeConfig.removeFormValue(["talk", "realtime", "providers", key, "speakerVoice"]);
      runtimeConfig.removeFormValue(["talk", "realtime", "providers", key, "voice"]);
    }
  }

  private previewVoice() {
    const client = this.connection?.client;
    if (!client || !this.connection?.connected || this.mutationDisabled) {
      return;
    }
    const selection = this.liveSelection();
    const provider = selectedTalkProviderOption(this.catalog, selection);
    if (!provider?.configured) {
      return;
    }
    const values = effectiveTalkValues(selection, provider);
    const model = values.model ?? provider.defaultModel;
    this.voicePreview.play(client, {
      provider: provider.id,
      ...(model ? { model } : {}),
      voice: values.speakerVoice,
    });
  }

  private selectedProviderConfigKeys(): string[] {
    const selection = this.liveSelection();
    const option = selectedTalkProviderOption(this.catalog, selection);
    return talkProviderConfigKeys(selection, option);
  }

  /**
   * Mutation helpers must read the live form draft, not the configObject prop:
   * the form updates immutably and the prop only refreshes on the next render,
   * so a same-tick read through the prop sees pre-write values.
   */
  private liveSelection() {
    const form = this.context.runtimeConfig.state.configForm;
    const configObject =
      form && typeof form === "object" ? (form as Record<string, unknown>) : this.configObject;
    return resolveTalkRealtimeSelection(configObject);
  }

  /**
   * Model and voice picks are provider-coupled, so a provider switch clears
   * those top-level overrides. Transport survives when the target provider
   * advertises it; an unavailable catalog is not evidence of incompatibility.
   * Each provider's own entry survives and supplies its fallback values.
   */
  private changeProvider(providerId: string | null) {
    if (this.mutationDisabled) {
      return;
    }
    this.voicePreview.stop();
    this.modelDefaultResetIntent = null;
    const runtimeConfig = this.context.runtimeConfig;
    const selection = this.liveSelection();
    for (const key of ["model", "speakerVoice", "speakerVoiceId"]) {
      runtimeConfig.removeFormValue(["talk", "realtime", key]);
    }
    if (providerId === null) {
      // Auto keeps the current transport: it was valid for the configuration
      // auto-selection will re-derive from (clearing it would strand a
      // relay-only provider on the client-owned default).
      runtimeConfig.removeFormValue(["talk", "realtime", "provider"]);
      return;
    }
    const configuredTransport = selection.transport;
    const option =
      this.catalog.kind === "ready"
        ? this.catalog.providers.find((provider) => provider.id === providerId)
        : undefined;
    const targetModel =
      effectiveTalkValues(
        { ...selection, provider: providerId, model: null, speakerVoice: null },
        option,
      ).model ?? option?.defaultModel;
    const rejectsTransport =
      configuredTransport !== null &&
      (gptLiveRejectsTransport(targetModel ?? null, configuredTransport) ||
        talkProviderRejectsTransport(option?.transports, configuredTransport));
    if (rejectsTransport) {
      runtimeConfig.removeFormValue(["talk", "realtime", "transport"]);
    }
    runtimeConfig.patchForm(["talk", "realtime", "provider"], providerId);
    // A relay-only provider (no client-owned transport) needs the transport
    // written explicitly when the current selection cannot carry across.
    const relayOnly =
      option !== undefined &&
      option.transports.length > 0 &&
      !option.transports.some((candidate) => TALK_CLIENT_OWNED_TRANSPORTS.has(candidate));
    let resultingTransport = rejectsTransport ? null : configuredTransport;
    if (relayOnly && configuredTransport !== "gateway-relay") {
      runtimeConfig.patchForm(["talk", "realtime", "transport"], "gateway-relay");
      resultingTransport = "gateway-relay";
    }
    if (
      option?.id === "openai" &&
      isTalkGptLiveModel(targetModel ?? null) &&
      resultingTransport === "gateway-relay" &&
      selection.consultRouting === "force-agent-consult"
    ) {
      runtimeConfig.removeFormValue(["talk", "realtime", "consultRouting"]);
    }
  }

  override render() {
    const runtimeState = this.context.runtimeConfig.state;
    const voiceWake = voiceWakeOwner(this.context.gateway);
    return renderTalk({
      nativeDeviceSettings: this.context.nativeDeviceSettings,
      voiceWake: {
        state: voiceWake.state,
        onInput: (text) => voiceWake.edit(text),
        onRetry: () => voiceWake.retry(),
      },
      selection: resolveTalkRealtimeSelection(this.configObject),
      catalog: this.catalog,
      modelDefaultPending: this.modelDefaultResetIntent !== null,
      configBusy:
        this.mutationDisabled ||
        runtimeState.configLoading ||
        runtimeState.configSaving ||
        runtimeState.configApplying,
      onProviderChange: (providerId) => this.changeProvider(providerId),
      onModelChange: (model) => this.changeModel(model),
      onVoiceChange: (voice) => {
        this.changeVoice(voice);
        this.previewVoice();
      },
      voicePreview: { state: this.voicePreview.state, onPlay: () => this.previewVoice() },
      editor: this.buildEditor(),
    });
  }
}

function sameCatalogScope(left: CatalogScope | null, right: CatalogScope | null): boolean {
  return (
    left !== null &&
    right !== null &&
    left.gatewayUrl === right.gatewayUrl &&
    left.connectionRevision === right.connectionRevision
  );
}

function sameCatalogGateway(left: CatalogScope | null, right: CatalogScope | null): boolean {
  return left !== null && right !== null && left.gatewayUrl === right.gatewayUrl;
}

if (!customElements.get("openclaw-talk-settings")) {
  customElements.define("openclaw-talk-settings", TalkSettingsPage);
}

export function renderTalkPage(props: TalkPageProps) {
  return html`
    <openclaw-talk-settings
      .configObject=${props.configObject}
      .mutationDisabled=${props.mutationDisabled}
      .buildEditor=${props.buildEditor}
    ></openclaw-talk-settings>
  `;
}
