import { useState } from 'react'
import { Button } from '../ui/Button.tsx'
import { Dialog } from '../ui/Dialog.tsx'
import { FormField } from '../ui/FormField.tsx'
import { Notice } from '../ui/Notice.tsx'
import { Select } from '../ui/Select.tsx'
import { TextInput } from '../ui/TextInput.tsx'
import { AGE_GROUP_OPTIONS, GENDER_OPTIONS } from '../../lib/labels.ts'
import type { AgeGroup, Gender, VisitorAttributes } from '../../lib/types.ts'

export type VisitorFormMode = 'create' | 'edit'

/** Form-local shape: accessory is a plain string field, `null` only on the wire. */
interface FormState {
  upperDescription: string
  lowerDescription: string
  accessory: string
  ageGroup: AgeGroup
  gender: Gender
}

interface VisitorFormProps {
  mode: VisitorFormMode
  /** Prefilled values in edit mode. */
  initial?: VisitorAttributes
  pending: boolean
  /** Rejected-command message, shown inside the dialog so input is kept. */
  errorMessage?: string
  onSubmit: (attributes: VisitorAttributes) => void
  onCancel: () => void
}

const EMPTY_FORM: FormState = {
  upperDescription: '',
  lowerDescription: '',
  accessory: '',
  ageGroup: 'Unknown',
  gender: 'Unknown',
}

function toFormState(attributes: VisitorAttributes): FormState {
  return { ...attributes, accessory: attributes.accessoryDescription ?? '' }
}

/** Trims and normalizes an empty accessory to `null`, matching the contract. */
function toAttributes(form: FormState): VisitorAttributes {
  const accessory = form.accessory.trim()
  return {
    upperDescription: form.upperDescription,
    lowerDescription: form.lowerDescription,
    accessoryDescription: accessory === '' ? null : accessory,
    ageGroup: form.ageGroup,
    gender: form.gender,
  }
}

/**
 * One form serves creation and attribute correction through an explicit
 * mode. It exposes profile fields only: registration times, purchase result
 * and assignment are lifecycle state and are never editable inputs here.
 *
 * Empty descriptions and Unknown demographics are valid submissions.
 *
 * The caller mounts it per opening, so the prefilled values are read once and
 * a 2s poll refresh can never overwrite what the receptionist typed.
 */
export function VisitorForm({ mode, initial, pending, errorMessage, onSubmit, onCancel }: VisitorFormProps) {
  const [form, setForm] = useState<FormState>(initial === undefined ? EMPTY_FORM : toFormState(initial))

  const title = mode === 'create' ? 'Add Visitor' : 'Edit Attributes'
  const description =
    mode === 'create'
      ? 'Entry time and queue position are set by the server. Leave a description empty and pick Unknown when you cannot tell.'
      : 'Corrects the visitor attributes only. Registration times, purchase result and assignment are unchanged, and manual values stay authoritative.'

  function update<K extends keyof FormState>(key: K, value: FormState[K]): void {
    setForm((current) => ({ ...current, [key]: value }))
  }

  return (
    <Dialog
      open
      title={title}
      description={description}
      onClose={onCancel}
      busy={pending}
      footer={
        <>
          <Button variant="secondary" onClick={onCancel} disabled={pending}>
            Cancel
          </Button>
          <Button variant="primary" pending={pending} onClick={() => onSubmit(toAttributes(form))}>
            {mode === 'create' ? 'Submit' : 'Save changes'}
          </Button>
        </>
      }
    >
      {errorMessage === undefined ? null : <Notice tone="error" title={errorMessage} />}

      <FormField id="upper-description" label="Upper clothing" optional hint="For example: navy puffer jacket.">
        <TextInput
          id="upper-description"
          value={form.upperDescription}
          disabled={pending}
          aria-describedby="upper-description-hint"
          onChange={(event) => update('upperDescription', event.target.value)}
        />
      </FormField>

      <FormField id="lower-description" label="Lower clothing" optional hint="For example: grey jeans.">
        <TextInput
          id="lower-description"
          value={form.lowerDescription}
          disabled={pending}
          aria-describedby="lower-description-hint"
          onChange={(event) => update('lowerDescription', event.target.value)}
        />
      </FormField>

      <FormField id="accessory" label="Accessory" optional>
        <TextInput
          id="accessory"
          value={form.accessory}
          disabled={pending}
          onChange={(event) => update('accessory', event.target.value)}
        />
      </FormField>

      <div className="grid gap-4 sm:grid-cols-2">
        <FormField id="age-group" label="Age group">
          <Select<AgeGroup>
            id="age-group"
            value={form.ageGroup}
            options={AGE_GROUP_OPTIONS}
            disabled={pending}
            onValueChange={(value) => update('ageGroup', value)}
          />
        </FormField>

        <FormField id="gender" label="Gender">
          <Select<Gender>
            id="gender"
            value={form.gender}
            options={GENDER_OPTIONS}
            disabled={pending}
            onValueChange={(value) => update('gender', value)}
          />
        </FormField>
      </div>
    </Dialog>
  )
}
