import {
  deriveAvailableInstanceId,
  deriveInstanceId,
} from "@t3tools/client-runtime/provider-instance-ids";
import {
  ClaudeSettings,
  defaultInstanceIdForDriver,
  isManagedSettingPath,
  ProviderDriverKind,
  ProviderInstanceId,
  type ManagedPolicySummary,
  type ProviderInstanceConfig,
  type ProviderInstanceMutation,
  type ServerSettings,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";

export const CLAUDE_DRIVER = ProviderDriverKind.make("claudeAgent");
export const DEFAULT_CLAUDE_INSTANCE_ID = defaultInstanceIdForDriver(CLAUDE_DRIVER);

export interface ClaudeAccountDraft {
  readonly name: string;
  readonly configDir: string;
}

function configRecord(instance: ProviderInstanceConfig | undefined): Record<string, unknown> {
  const config = instance?.config;
  return config !== null && typeof config === "object" ? (config as Record<string, unknown>) : {};
}

export function claudeConfigDir(instance: ProviderInstanceConfig | undefined): string {
  const homePath = configRecord(instance).homePath;
  return typeof homePath === "string" ? homePath : "";
}

const codeModeAnnotations = Schema.resolveAnnotationsKey(ClaudeSettings.fields.codeMode);
export const CLAUDE_CODE_MODE_TITLE = String(codeModeAnnotations?.title ?? "Code Mode");
export const CLAUDE_CODE_MODE_DESCRIPTION = String(codeModeAnnotations?.description ?? "");

export function claudeCodeMode(instance: ProviderInstanceConfig | undefined): boolean {
  return configRecord(instance).codeMode === true;
}

/** Turns Code Mode on or off for a Claude instance, keeping every other setting. */
export function planClaudeCodeModeSave(input: {
  readonly providerInstances: ServerSettings["providerInstances"];
  readonly policy: ManagedPolicySummary | undefined;
  readonly instanceId: ProviderInstanceId;
  readonly codeMode: boolean;
}): { readonly mutation: ProviderInstanceMutation } | { readonly error: string } {
  if (input.policy && isManagedSettingPath(input.policy, `providerInstances.${input.instanceId}`)) {
    return { error: `Managed by ${input.policy.organization}.` };
  }
  const current: ProviderInstanceConfig = Object.hasOwn(input.providerInstances, input.instanceId)
    ? input.providerInstances[input.instanceId]!
    : { driver: CLAUDE_DRIVER };
  return {
    mutation: {
      operation: "upsert",
      instanceId: input.instanceId,
      instance: { ...current, config: { ...configRecord(current), codeMode: input.codeMode } },
    },
  };
}

/** Adds a Claude instance (`instanceId` null) or edits one, keeping every field the form doesn't show. */
export function planClaudeAccountSave(input: {
  readonly providerInstances: ServerSettings["providerInstances"];
  readonly policy: ManagedPolicySummary | undefined;
  readonly instanceId: ProviderInstanceId | null;
  readonly draft: ClaudeAccountDraft;
}): { readonly mutation: ProviderInstanceMutation } | { readonly error: string } {
  const name = input.draft.name.trim();
  const configDir = input.draft.configDir.trim();
  const adding = input.instanceId === null;
  if (adding && name.length === 0) return { error: "Enter a name for this account." };
  if (adding && configDir.length === 0) {
    return { error: "Enter the Claude config folder this account is signed in with." };
  }
  const instanceId =
    input.instanceId ??
    ProviderInstanceId.make(
      deriveAvailableInstanceId(
        (label) => deriveInstanceId(CLAUDE_DRIVER, label) || CLAUDE_DRIVER,
        name,
        new Set([DEFAULT_CLAUDE_INSTANCE_ID, ...Object.keys(input.providerInstances)]),
      ),
    );
  if (input.policy && isManagedSettingPath(input.policy, `providerInstances.${instanceId}`)) {
    return { error: `Managed by ${input.policy.organization}.` };
  }
  const current: ProviderInstanceConfig = Object.hasOwn(input.providerInstances, instanceId)
    ? input.providerInstances[instanceId]!
    : { driver: CLAUDE_DRIVER };
  const { displayName: _displayName, config: _config, ...rest } = current;
  const { homePath: _homePath, ...config } = configRecord(current);
  const nextConfig = configDir ? { ...config, homePath: configDir } : config;
  const instance: ProviderInstanceConfig = {
    ...rest,
    ...(adding ? { enabled: true } : {}),
    ...(name ? { displayName: name } : {}),
    ...(Object.keys(nextConfig).length > 0 ? { config: nextConfig } : {}),
  };
  return {
    mutation: { operation: adding ? "create" : "upsert", instanceId, instance },
  };
}
