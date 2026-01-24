---
description: Review and resolve bot code review comments on a PR
allowed-tools: Bash, Read, Edit, Write, Grep, Glob
argument-hint: <PR_NUMBER>
---

# Resolve PR Comments

Fetch and triage bot review comments (CodeRabbit, Greptile), then:
1. Summarize what's valid vs not applicable
2. Create fixes for valid issues
3. Use gh CLI to reply/resolve comments
4. Commit fixes to the PR branch

## Arguments

$ARGUMENTS is the PR number (e.g., `97`)

## Workflow

### 1. Fetch PR Data

```bash
# Get PR info and reviews
gh pr view $ARGUMENTS --json body,reviews,state,headRefName

# Fetch inline comments (review comments, not issue comments)
gh api repos/{owner}/{repo}/pulls/$ARGUMENTS/comments
```

### 2. Triage Each Comment

Categorize each bot comment as:
- **Valid**: Real issue, needs fix
- **Not Applicable**: Doesn't apply to this codebase/context (e.g., Windows concerns for macOS-only app)
- **Nitpick**: Nice to have but not blocking; optionally accept

Present a summary table to the user:

| Source | File | Issue | Valid? | Action |
|--------|------|-------|--------|--------|
| Bot | file:line | summary | ✅/❌/🟡 | Fix/Dismiss/Accept |

### 3. Implement Fixes

For each valid issue:
1. Read the file
2. Apply the fix
3. Note what was changed

### 4. Reply to PR Comments

```bash
# Reply to inline comment
gh api repos/{owner}/{repo}/pulls/$ARGUMENTS/comments/{comment_id}/replies \
  -f body="Fixed in efdf99f - added error logging and objectStore guard"

# For general reply (not inline)
gh pr review $ARGUMENTS --comment --body "..."
```

### 5. Commit and Push

```bash
git add <files>
git commit -m "fix: address code review feedback"
git push
```

### 6. Report

List:
- Commits created
- Comments replied to
- Any items dismissed with reason

## Tips

- Use `gh api --paginate` for repos with many comments
- Comment IDs are in the API response as `id` field
- For duplicate comments (same issue from multiple bots), fix once and reply to all
