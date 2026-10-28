import { renderToStaticMarkup } from 'react-dom/server'
import { expect, it } from 'vitest'
import App from './App.tsx'

it('renders the shell and dashboard without throwing', () => {
  const html = renderToStaticMarkup(<App />)
  expect(html).toContain('Digital UP Board')
  expect(html).toContain('Shift summary')
  expect(html).toContain('Coming soon')
  expect(html).toContain('Visitors')
  expect(html).toContain('Associates')
  expect(html).toContain('Add Visitor')
  expect(html).toContain('Reset Demo')
  expect(html).toContain('Mock mode')
})
