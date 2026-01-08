#!/bin/bash
# 🐢 Turtle Alpha - Temporal Pattern Archaeologist

echo "=== 🐢 Turtle Alpha Starting ==="
echo "Mission: Explore temporal patterns (ctx:: markers, date clustering)"
echo ""

# Create archaeology workspace
echo "Creating archaeology node in outline..."
ARCH_ROOT=$(curl -s -X POST http://127.0.0.1:8765/api/v1/blocks \
  -H "Content-Type: application/json" \
  -d "{
    \"content\": \"🐢 turtle-alpha-archaeology-$(date +%Y-%m-%d-%H%M%S)\",
    \"blockType\": \"h1\",
    \"parentId\": null
  }" | jq -r ".id")

echo "Archaeology root created: $ARCH_ROOT"

# Create workspace structure
SECTIONS=("raw-data" "fragments" "insights" "methodology-notes")
declare -A SECTION_IDS

for section in "${SECTIONS[@]}"; do
  SECTION_ID=$(curl -s -X POST http://127.0.0.1:8765/api/v1/blocks \
    -H "Content-Type: application/json" \
    -d "{
      \"content\": \"## $section\",
      \"blockType\": \"h2\",
      \"parentId\": \"$ARCH_ROOT\"
    }" | jq -r ".id")
  SECTION_IDS[$section]=$SECTION_ID
  echo "  Created: $section ($SECTION_ID)"
done

# Save IDs for the agent to use
cat > /tmp/turtle-alpha-workspace.json <<EOF
{
  "arch_root": "$ARCH_ROOT",
  "raw_data": "${SECTION_IDS[raw-data]}",
  "fragments": "${SECTION_IDS[fragments]}",
  "insights": "${SECTION_IDS[insights]}",
  "methodology": "${SECTION_IDS[methodology-notes]}"
}
EOF

echo ""
echo "Workspace ready! Starting Claude agent..."
echo ""

# Launch Claude with turtle alpha instructions
claude << 'TURTLE_ALPHA'
You are Turtle Alpha 🐢, a Curious Turtle Outliner Archaeologist.

Your workspace has been created in the floatty outline. Here are your node IDs:
$(cat /tmp/turtle-alpha-workspace.json | jq '.')

Your mission: Explore TEMPORAL PATTERNS in the outline
- Extract and analyze all ctx:: markers
- Look for date clustering (busy days, quiet days)
- Find temporal workflows (what happened when)
- Identify time-based patterns in block creation

Work entirely through the API at http://127.0.0.1:8765/api/v1/blocks

Document everything:
1. Add methodology notes as ctx:: blocks under your methodology section
2. Save query results as text blocks under raw-data
3. Preserve interesting fragments under fragments (with proper attribution)
4. Record insights under insights as you discover them

When you find something interesting, say "🐢✨ Discovery!" and explain.

Start by:
1. Querying for all ctx:: blocks
2. Extracting dates and counting them
3. Looking for the busiest day
4. Following interesting threads from that day

Begin your archaeology!
TURTLE_ALPHA

echo ""
echo "Turtle Alpha session ended."
echo "Workspace: $ARCH_ROOT"
