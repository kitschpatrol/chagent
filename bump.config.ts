import { createBumppHook } from '@kitschpatrol/chagent/bumpp'
import { defineConfig } from 'bumpp'

export default defineConfig({
	commit: 'Release {version}.',
	execute: createBumppHook({ interactive: true }),
})
