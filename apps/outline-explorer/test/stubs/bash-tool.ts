// Vitest stub for `bash-tool`.
// The real package transitively depends on `just-bash` which isn't installed
// in this workspace; our tests don't exercise the skill-tool path, so a no-op
// stub keeps the import chain happy.
export async function experimental_createSkillTool() {
  return { skills: [] as Array<{ name: string }>, skill: undefined };
}
