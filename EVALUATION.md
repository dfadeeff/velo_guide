# Quality Evaluation Plan

## Evaluation Dimensions

### 1. Factual Accuracy (Critical)
Are distances, cycling times, and elevation values sourced from the `plan_route` tool, not hallucinated by the LLM?

**Method**: For each response, verify that every distance/time claim appears in the preceding tool call result. Flag any numeric claim without a tool source.

**Metric**: `factual_grounding_rate` = claims with tool source / total numeric claims. Target: >95%.

### 2. POI Validity
Do mentioned restaurants, cafes, and attractions actually exist?

**Method**: Cross-reference every named POI against the `find_pois` or `find_accommodation` tool result in the conversation trace. Sample-check 10% against Google Maps.

**Metric**: `poi_existence_rate` = verifiable POIs / total mentioned POIs. Target: >90%.

### 3. Route Feasibility
Is the proposed route actually cyclable? No highways, no missing water crossings, reasonable daily distances?

**Method**: Check that `plan_route` returned success (not an error). Verify daily distance is within the stated fitness level guidelines (casual <80 km, experienced <130 km).

**Metric**: `route_feasibility_rate`. Target: 100% (tool-computed routes are inherently feasible).

### 4. Weather Appropriateness
Does the itinerary acknowledge adverse weather? Are indoor alternatives suggested when it rains?

**Method**: Check `get_weather` tool output. If precipitation >5mm or wind >30 km/h, verify the response acknowledges it and adjusts recommendations.

**Metric**: `weather_acknowledgment_rate` for adverse conditions. Target: >90%.

### 5. Completeness
Does a multi-day plan include all essential elements?

**Checklist** (score 1 point each):
- [ ] Daily distance and estimated cycling time
- [ ] Lunch stop with a specific named place
- [ ] Coffee/rest stop
- [ ] Accommodation for overnight (multi-day only)
- [ ] Knooppunten junction numbers mentioned
- [ ] Weather advisory
- [ ] Practical tip (water, bike repair, train connection)

**Metric**: `completeness_score` = items checked / total items. Target: >80%.

### 6. Graceful Degradation
How does the system handle edge cases and failures?

**Test cases**:
- API timeout/failure → should communicate limitation, not crash
- Dates too far ahead → should explain forecast limitation
- No POIs found in area → should say so, not invent
- Unreasonable distance request → should flag and suggest alternatives
- Non-Netherlands location → should redirect to NL scope

**Metric**: `graceful_handling_rate`. Target: 100%.

### 7. Dutch Cycling Authenticity
Does the output demonstrate genuine Netherlands cycling knowledge?

**Checklist**:
- [ ] Knooppunten mentioned with actual junction numbers
- [ ] Dutch cycling terms used (fietspad, pontje, etc.)
- [ ] Wind direction considered in route planning
- [ ] NS train connections mentioned for one-way routes
- [ ] Region-appropriate suggestions (Veluwe for nature, Kinderdijk for windmills, etc.)

## Test Scenarios

### Scenario 1: Basic Day Trip
**Input**: "Plan a one-day cycling trip from Amsterdam"
**Expected**: Geocode Amsterdam → get weather for today → plan route to a nearby destination → find POIs along route → find knooppunten → structured itinerary with 40-60 km.

### Scenario 2: Multi-Day Experienced
**Input**: "Plan a 3-day trip through the Veluwe for an experienced cyclist"
**Expected**: Longer daily distances (80-100 km), forest routes, accommodation each night, Veluwe-specific attractions (Hoge Veluwe park, Kröller-Müller museum).

### Scenario 3: Specific Destination
**Input**: "I want to cycle from Rotterdam to Kinderdijk to see the windmills. I'm a beginner."
**Expected**: Short route (~30 km round trip), windmill-specific POIs, beginner-friendly advice, ferry crossing mentioned.

### Scenario 4: Image Input
**Input**: Photo of a Dutch landscape + "I want to cycle somewhere that looks like this"
**Expected**: Agent describes the image, identifies landscape type, suggests matching region.

### Scenario 5: Unreasonable Request
**Input**: "I want to cycle 200 km in one day, I'm a casual cyclist"
**Expected**: Agent flags this as unreasonable (~12+ hours cycling), suggests splitting into 2-3 days.

### Scenario 6: Far-Future Date
**Input**: "Plan a trip for December 2027"
**Expected**: Agent plans route and POIs but explains weather forecast is unavailable beyond 16 days.

### Scenario 7: Seasonal Query
**Input**: "Where should I cycle to see tulips in April?"
**Expected**: Web search for tulip season info, suggest Keukenhof/Lisse area, plan route.

## Automated Evaluation (Future)

For regression testing at scale:

1. **Tool call trace analysis**: Parse agent event logs, verify every factual claim maps to a tool result
2. **LLM-as-judge**: Use a second LLM to evaluate completeness and Dutch authenticity against the checklist
3. **Response time tracking**: Measure end-to-end latency (target: <30s for a complete itinerary)
4. **A/B model comparison**: Run same scenarios across Gemini Flash vs Claude Sonnet, score both

## Evaluation Cadence

- **Pre-release**: Run all 7 scenarios manually, score all dimensions
- **Weekly**: Automated regression on scenarios 1, 2, 3, 5, 6
- **Per model change**: Full evaluation suite with LLM-as-judge scoring
