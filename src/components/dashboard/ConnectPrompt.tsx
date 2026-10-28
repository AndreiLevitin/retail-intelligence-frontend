import { useState } from 'react'
import { Button } from '../ui/Button.tsx'
import { Dialog } from '../ui/Dialog.tsx'
import { FormField } from '../ui/FormField.tsx'
import { TextInput } from '../ui/TextInput.tsx'

interface ConnectPromptProps {
  open: boolean
  onConnect: (token: string | null) => void
}

/**
 * Small one-time prompt for the operator token used by HttpBoardClient. It is
 * not an account or login system: the value is kept in memory for this tab
 * only and is never written to storage or into the build.
 */
export function ConnectPrompt({ open, onConnect }: ConnectPromptProps) {
  const [token, setToken] = useState('')

  return (
    <Dialog
      open={open}
      title="Connect to the board service"
      description="Paste the operator token for this demo environment. It is held in memory for this tab only."
      onClose={() => onConnect(null)}
      footer={
        <>
          <Button variant="secondary" onClick={() => onConnect(null)}>
            Continue without a token
          </Button>
          <Button variant="primary" disabled={token.trim() === ''} onClick={() => onConnect(token)}>
            Connect
          </Button>
        </>
      }
    >
      <FormField
        id="operator-token"
        label="Operator token"
        optional
        hint="Leave empty if this environment does not require one."
      >
        <TextInput
          id="operator-token"
          value={token}
          autoComplete="off"
          aria-describedby="operator-token-hint"
          onChange={(event) => setToken(event.target.value)}
        />
      </FormField>
    </Dialog>
  )
}
