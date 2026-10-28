import { Button } from '../ui/Button.tsx'
import { Notice } from '../ui/Notice.tsx'
import { Select } from '../ui/Select.tsx'
import { MOCK_SCENARIOS, findScenario } from '../../services/mockScenarios.ts'
import type { ScenarioId } from '../../services/mockScenarios.ts'

interface MockModePanelProps {
  scenarioId: ScenarioId
  onSelectScenario: (id: ScenarioId) => void
  onFailNextRead: () => void
}

const SCENARIO_OPTIONS = MOCK_SCENARIOS.map((scenario) => ({
  value: scenario.id,
  label: scenario.label,
}))

/**
 * Mock mode is marked explicitly during review. It is rendered only when the
 * app was started against MockBoardClient, and the app never falls back to it
 * after a real API error.
 */
export function MockModePanel({ scenarioId, onSelectScenario, onFailNextRead }: MockModePanelProps) {
  const scenario = findScenario(scenarioId)

  return (
    <Notice tone="warning" title="Mock mode — no backend is connected">
      <div className="mt-2 flex flex-col gap-3">
        <p className="text-body">{scenario.description}</p>
        <div className="flex flex-wrap items-center gap-3">
          <div className="w-64">
            <label htmlFor="mock-scenario" className="sr-only">
              Mock scenario
            </label>
            <Select<ScenarioId>
              id="mock-scenario"
              value={scenarioId}
              options={SCENARIO_OPTIONS}
              onValueChange={onSelectScenario}
            />
          </div>
          <Button size="sm" variant="secondary" onClick={onFailNextRead}>
            Fail the next read
          </Button>
        </div>
      </div>
    </Notice>
  )
}
