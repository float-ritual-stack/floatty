import { describe, it, expect } from 'vitest';
import { buildEnrichmentPrompt, parseAgentResponse } from './agentEnrichmentProjection';
import type { Marker } from '../../generated/Marker';

// ═══════════════════════════════════════════════════════════════
// buildEnrichmentPrompt
// ═══════════════════════════════════════════════════════════════

describe('buildEnrichmentPrompt', () => {
  it('includes block content', () => {
    const result = buildEnrichmentPrompt('Fix bug #123 in the server', []);
    expect(result).toContain('Fix bug #123 in the server');
  });

  it('includes inherited markers when present', () => {
    const markers: Marker[] = [
      { markerType: 'project', value: 'floatty' },
      { markerType: 'mode', value: 'dev' },
    ];
    const result = buildEnrichmentPrompt('Some content', markers);
    expect(result).toContain('project::floatty');
    expect(result).toContain('mode::dev');
    expect(result).toContain('Inherited context markers');
  });

  it('omits inherited section when no markers', () => {
    const result = buildEnrichmentPrompt('Some content', []);
    expect(result).not.toContain('Inherited');
  });

  it('handles markers without values', () => {
    const markers: Marker[] = [{ markerType: 'ctx', value: null }];
    const result = buildEnrichmentPrompt('content', markers);
    expect(result).toContain('ctx');
    expect(result).not.toContain('ctx::null');
  });
});

// ═══════════════════════════════════════════════════════════════
// parseAgentResponse
// ═══════════════════════════════════════════════════════════════

describe('parseAgentResponse', () => {
  it('parses valid JSON with markers', () => {
    const response = '{"markers": [{"markerType": "issue", "value": "123"}]}';
    const result = parseAgentResponse(response);

    expect(result.markers).toHaveLength(1);
    expect(result.markers[0]).toEqual({ markerType: 'issue', value: '123' });
  });

  it('parses multiple markers', () => {
    const response = JSON.stringify({
      markers: [
        { markerType: 'issue', value: '123' },
        { markerType: 'ambiguous-ref', value: 'the server' },
      ],
    });
    const result = parseAgentResponse(response);

    expect(result.markers).toHaveLength(2);
    expect(result.markers[0].markerType).toBe('issue');
    expect(result.markers[1].markerType).toBe('ambiguous-ref');
  });

  it('returns empty markers for empty array', () => {
    const result = parseAgentResponse('{"markers": []}');
    expect(result.markers).toEqual([]);
  });

  it('returns empty markers for malformed JSON', () => {
    const result = parseAgentResponse('not json at all');
    expect(result.markers).toEqual([]);
  });

  it('returns empty markers for empty string', () => {
    const result = parseAgentResponse('');
    expect(result.markers).toEqual([]);
  });

  it('returns empty markers when markers field is missing', () => {
    const result = parseAgentResponse('{"other": "data"}');
    expect(result.markers).toEqual([]);
  });

  it('returns empty markers when markers is not an array', () => {
    const result = parseAgentResponse('{"markers": "not-array"}');
    expect(result.markers).toEqual([]);
  });

  it('strips markdown code fences', () => {
    const response = '```json\n{"markers": [{"markerType": "issue", "value": "456"}]}\n```';
    const result = parseAgentResponse(response);

    expect(result.markers).toHaveLength(1);
    expect(result.markers[0].value).toBe('456');
  });

  it('filters out markers missing markerType', () => {
    const response = JSON.stringify({
      markers: [
        { markerType: 'issue', value: '123' },
        { value: 'no-type' }, // Missing markerType
        { markerType: '', value: 'empty-type' }, // Empty markerType
      ],
    });
    const result = parseAgentResponse(response);

    expect(result.markers).toHaveLength(1);
    expect(result.markers[0].markerType).toBe('issue');
  });

  it('handles null values gracefully', () => {
    const response = '{"markers": [{"markerType": "ctx", "value": null}]}';
    const result = parseAgentResponse(response);

    expect(result.markers).toHaveLength(1);
    expect(result.markers[0].value).toBeNull();
  });

  it('converts non-string values to null', () => {
    const response = '{"markers": [{"markerType": "issue", "value": 123}]}';
    const result = parseAgentResponse(response);

    expect(result.markers).toHaveLength(1);
    expect(result.markers[0].value).toBeNull();
  });

  it('ignores extra fields in markers', () => {
    const response = JSON.stringify({
      markers: [{ markerType: 'issue', value: '42', confidence: 0.9, extra: true }],
    });
    const result = parseAgentResponse(response);

    expect(result.markers).toHaveLength(1);
    expect(result.markers[0]).toEqual({ markerType: 'issue', value: '42' });
  });

  it('handles non-object markers array items', () => {
    const response = '{"markers": ["string", 42, null, {"markerType": "issue", "value": "1"}]}';
    const result = parseAgentResponse(response);

    expect(result.markers).toHaveLength(1);
    expect(result.markers[0].markerType).toBe('issue');
  });
});
