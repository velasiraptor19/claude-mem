import { expect, it } from 'bun:test';
import { setTomlFeatureEnabled, setTomlPluginEnabled, removeLegacyCodexMcpSearchConfig } from '../../src/services/integrations/CodexCliInstaller.js';

it('updates an existing commented features table without duplicating it', () => {
  const input = '[features] # existing operator config\nhooks = false\nother = true\n';
  const output = setTomlFeatureEnabled(input, 'hooks', true);
  expect(Bun.TOML.parse(output)).toEqual({ features: { hooks: true, other: true } });
});

it('updates an existing commented plugin table and keeps hashes inside quoted IDs', () => {
  const input = '[plugins."fixture#plugin"] # configured seat\nenabled = false\n';
  const output = setTomlPluginEnabled(input, 'fixture#plugin', true);
  expect(Bun.TOML.parse(output)).toEqual({ plugins: { 'fixture#plugin': { enabled: true } } });
});

it('removes a commented legacy claude-mem server table', () => {
  const input = '[mcp_servers."mcp-search"] # installed legacy server\ncommand = "bun"\nargs = ["claude-mem/mcp-server.cjs"]\n[mcp_servers.other] # unrelated\ncommand = "other-server"\n';
  const output = removeLegacyCodexMcpSearchConfig(input);
  expect(Bun.TOML.parse(output)).toEqual({ mcp_servers: { other: { command: 'other-server' } } });
});

it('preserves a commented sibling table while removing the legacy table', () => {
  const input = '[mcp_servers."mcp-search"]\nargs = ["claude-mem/mcp-server.cjs"]\n[mcp_servers.other] # unrelated\ncommand = "other-server"\n';
  expect(Bun.TOML.parse(removeLegacyCodexMcpSearchConfig(input))).toEqual({ mcp_servers: { other: { command: 'other-server' } } });
});

// Compare parser results before/after; Bun versions differ on the opening newline.
for (const delimiter of ['"""', "'''"]) {
  it(`preserves feature and legacy-server examples inside ${delimiter} instructions`, () => {
    const instructions = '[features] # example\nhooks = false\n[mcp_servers."mcp-search"] # example\nargs = ["claude-mem/example"]';
    const input = `developer_instructions = ${delimiter}\n${instructions}\n${delimiter}\n[features] # real table\nhooks = false\n[mcp_servers."mcp-search"] # real legacy server\nargs = ["claude-mem/mcp-server.cjs"]\n[mcp_servers.other]\ncommand = "other-server"\n`;
    const enabled = setTomlFeatureEnabled(input, 'hooks', true);
    const parsed = Bun.TOML.parse(enabled) as any;
    expect(parsed.developer_instructions).toBe((Bun.TOML.parse(input) as any).developer_instructions);
    expect(parsed.features.hooks).toBe(true);
    const output = removeLegacyCodexMcpSearchConfig(enabled);
    expect(output).toContain(`developer_instructions = ${delimiter}\n${instructions}\n${delimiter}`);
    const cleaned = Bun.TOML.parse(output) as any;
    expect(cleaned.developer_instructions).toBe((Bun.TOML.parse(input) as any).developer_instructions);
    expect(cleaned.features.hooks).toBe(true);
    expect(cleaned.mcp_servers).toEqual({ other: { command: 'other-server' } });
  });

  it(`does not replace an example key or terminate the real table inside ${delimiter}`, () => {
    const instructions = 'hooks = false\n[features] # example';
    const input = `[features]\ndeveloper_instructions = ${delimiter}\n${instructions}\n${delimiter}\nother = true\n`;
    const output = setTomlFeatureEnabled(input, 'hooks', true);
    expect(output).toContain(`developer_instructions = ${delimiter}\n${instructions}\n${delimiter}`);
    const parsed = Bun.TOML.parse(output) as any;
    expect(parsed.features).toEqual({ hooks: true, other: true, developer_instructions: (Bun.TOML.parse(input) as any).features.developer_instructions });
  });

  it(`adds a real feature table when only a ${delimiter} example exists`, () => {
    const instructions = '[features] # example\nhooks = false';
    const input = `developer_instructions = ${delimiter}\n${instructions}\n${delimiter}\n`;
    const output = setTomlFeatureEnabled(input, 'hooks', true);
    expect(output).toContain(`developer_instructions = ${delimiter}\n${instructions}\n${delimiter}`);
    const parsed = Bun.TOML.parse(output) as any;
    expect(parsed.developer_instructions).toBe((Bun.TOML.parse(input) as any).developer_instructions);
    expect(parsed.features.hooks).toBe(true);
    expect(removeLegacyCodexMcpSearchConfig(input)).toBe(input);
  });
}
