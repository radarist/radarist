/**
 * @file useAutosave.test.ts
 * @description Tests for the useAutosave hook
 */

import { renderHook, act, waitFor } from '@testing-library/react'
import { useAutosave } from '../useAutosave'

// Mock timers
jest.useFakeTimers()

describe('useAutosave', () => {
  // ============================================================================
  // INITIAL STATE
  // ============================================================================

  describe('initial state', () => {
    it('should start with idle status', () => {
      const onSave = jest.fn().mockResolvedValue(undefined)
      const { result } = renderHook(() =>
        useAutosave({
          data: 'initial',
          onSave,
        })
      )

      expect(result.current.status).toBe('idle')
      expect(result.current.lastSaved).toBeNull()
      expect(result.current.error).toBeNull()
    })

    it('should not trigger save on initial render', () => {
      const onSave = jest.fn().mockResolvedValue(undefined)
      renderHook(() =>
        useAutosave({
          data: 'initial',
          onSave,
        })
      )

      // Advance past debounce
      act(() => {
        jest.advanceTimersByTime(3000)
      })

      expect(onSave).not.toHaveBeenCalled()
    })
  })

  // ============================================================================
  // AUTOSAVE BEHAVIOR
  // ============================================================================

  describe('autosave behavior', () => {
    it('should trigger save after debounce when data changes', async () => {
      const onSave = jest.fn().mockResolvedValue(undefined)
      const { result: _result, rerender } = renderHook(
        ({ data }) =>
          useAutosave({
            data,
            onSave,
            debounceMs: 1000,
          }),
        { initialProps: { data: 'initial' } }
      )

      // Change data
      rerender({ data: 'updated' })

      // Should not save immediately
      expect(onSave).not.toHaveBeenCalled()

      // Advance past debounce
      await act(async () => {
        jest.advanceTimersByTime(1000)
      })

      expect(onSave).toHaveBeenCalledWith('updated')
    })

    it('should reset debounce timer on rapid changes', async () => {
      const onSave = jest.fn().mockResolvedValue(undefined)
      const { rerender } = renderHook(
        ({ data }) =>
          useAutosave({
            data,
            onSave,
            debounceMs: 1000,
          }),
        { initialProps: { data: 'initial' } }
      )

      // Rapid changes
      rerender({ data: 'change1' })
      act(() => {
        jest.advanceTimersByTime(500)
      })

      rerender({ data: 'change2' })
      act(() => {
        jest.advanceTimersByTime(500)
      })

      rerender({ data: 'change3' })

      // Should not have saved yet (timer keeps resetting)
      expect(onSave).not.toHaveBeenCalled()

      // Now wait for full debounce
      await act(async () => {
        jest.advanceTimersByTime(1000)
      })

      // Should only save once with final value
      expect(onSave).toHaveBeenCalledTimes(1)
      expect(onSave).toHaveBeenCalledWith('change3')
    })

    it('should not save if data reverts to previous value', async () => {
      const onSave = jest.fn().mockResolvedValue(undefined)
      const { rerender } = renderHook(
        ({ data }) =>
          useAutosave({
            data,
            onSave,
            debounceMs: 1000,
          }),
        { initialProps: { data: 'initial' } }
      )

      // Change then revert
      rerender({ data: 'changed' })
      act(() => {
        jest.advanceTimersByTime(500)
      })
      rerender({ data: 'initial' })

      // Wait for debounce
      await act(async () => {
        jest.advanceTimersByTime(1500)
      })

      // Should not save (reverted to initial)
      expect(onSave).not.toHaveBeenCalled()
    })
  })

  // ============================================================================
  // STATUS TRANSITIONS
  // ============================================================================

  describe('status transitions', () => {
    it('should transition to saving status during save', async () => {
      let resolveSave: () => void
      const onSave = jest.fn().mockImplementation(
        () =>
          new Promise<void>((resolve) => {
            resolveSave = resolve
          })
      )

      const { result, rerender } = renderHook(
        ({ data }) =>
          useAutosave({
            data,
            onSave,
            debounceMs: 100,
          }),
        { initialProps: { data: 'initial' } }
      )

      rerender({ data: 'updated' })

      await act(async () => {
        jest.advanceTimersByTime(100)
      })

      expect(result.current.status).toBe('saving')

      await act(async () => {
        resolveSave!()
      })

      expect(result.current.status).toBe('saved')
    })

    it('should transition to saved status after successful save', async () => {
      const onSave = jest.fn().mockResolvedValue(undefined)
      const { result, rerender } = renderHook(
        ({ data }) =>
          useAutosave({
            data,
            onSave,
            debounceMs: 100,
          }),
        { initialProps: { data: 'initial' } }
      )

      rerender({ data: 'updated' })

      await act(async () => {
        jest.advanceTimersByTime(100)
      })

      await waitFor(() => {
        expect(result.current.status).toBe('saved')
      })

      expect(result.current.lastSaved).toBeInstanceOf(Date)
    })

    it('should transition to error status on save failure', async () => {
      const error = new Error('Save failed')
      const onSave = jest.fn().mockRejectedValue(error)
      const onError = jest.fn()

      const { result, rerender } = renderHook(
        ({ data }) =>
          useAutosave({
            data,
            onSave,
            onError,
            debounceMs: 100,
          }),
        { initialProps: { data: 'initial' } }
      )

      rerender({ data: 'updated' })

      await act(async () => {
        jest.advanceTimersByTime(100)
      })

      await waitFor(() => {
        expect(result.current.status).toBe('error')
      })

      expect(result.current.error).toBe(error)
      expect(onError).toHaveBeenCalledWith(error)
    })

    it('does not retry a failed save merely because an inline callback changes identity', async () => {
      const persistence = jest.fn().mockRejectedValue(new Error('Save failed'))
      const { result, rerender } = renderHook(
        ({ data }) =>
          useAutosave({
            data,
            onSave: async (value) => persistence(value),
            debounceMs: 100,
          }),
        { initialProps: { data: 'initial' } }
      )

      rerender({ data: 'updated' })

      await act(async () => {
        jest.advanceTimersByTime(100)
      })
      await waitFor(() => expect(result.current.status).toBe('error'))

      // Status updates rerender the hook and recreate the inline callback. A
      // stable debounce contract must not interpret that as another data edit.
      await act(async () => {
        jest.advanceTimersByTime(1000)
      })

      expect(persistence).toHaveBeenCalledTimes(1)
    })

    it('should return to idle status after 2 seconds of saved', async () => {
      const onSave = jest.fn().mockResolvedValue(undefined)
      const { result, rerender } = renderHook(
        ({ data }) =>
          useAutosave({
            data,
            onSave,
            debounceMs: 100,
          }),
        { initialProps: { data: 'initial' } }
      )

      rerender({ data: 'updated' })

      await act(async () => {
        jest.advanceTimersByTime(100)
      })

      await waitFor(() => {
        expect(result.current.status).toBe('saved')
      })

      // Wait for idle transition
      await act(async () => {
        jest.advanceTimersByTime(2000)
      })

      expect(result.current.status).toBe('idle')
    })
  })

  // ============================================================================
  // ENABLED/DISABLED
  // ============================================================================

  describe('enabled prop', () => {
    it('should not save when disabled', async () => {
      const onSave = jest.fn().mockResolvedValue(undefined)
      const { rerender } = renderHook(
        ({ data, enabled }) =>
          useAutosave({
            data,
            onSave,
            enabled,
            debounceMs: 100,
          }),
        { initialProps: { data: 'initial', enabled: false } }
      )

      rerender({ data: 'updated', enabled: false })

      await act(async () => {
        jest.advanceTimersByTime(200)
      })

      expect(onSave).not.toHaveBeenCalled()
    })

    it('should save when re-enabled after data change', async () => {
      const onSave = jest.fn().mockResolvedValue(undefined)
      const { rerender } = renderHook(
        ({ data, enabled }) =>
          useAutosave({
            data,
            onSave,
            enabled,
            debounceMs: 100,
          }),
        { initialProps: { data: 'initial', enabled: false } }
      )

      // Change data while disabled
      rerender({ data: 'updated', enabled: false })

      await act(async () => {
        jest.advanceTimersByTime(200)
      })

      expect(onSave).not.toHaveBeenCalled()

      // Re-enable
      rerender({ data: 'updated', enabled: true })

      await act(async () => {
        jest.advanceTimersByTime(200)
      })

      expect(onSave).toHaveBeenCalledWith('updated')
    })
  })

  // ============================================================================
  // CALLBACKS
  // ============================================================================

  describe('callbacks', () => {
    it('should call onSuccess after successful save', async () => {
      const onSave = jest.fn().mockResolvedValue(undefined)
      const onSuccess = jest.fn()

      const { rerender } = renderHook(
        ({ data }) =>
          useAutosave({
            data,
            onSave,
            onSuccess,
            debounceMs: 100,
          }),
        { initialProps: { data: 'initial' } }
      )

      rerender({ data: 'updated' })

      await act(async () => {
        jest.advanceTimersByTime(100)
      })

      await waitFor(() => {
        expect(onSuccess).toHaveBeenCalled()
      })
    })

    it('should call onError on save failure', async () => {
      const error = new Error('Save failed')
      const onSave = jest.fn().mockRejectedValue(error)
      const onError = jest.fn()

      const { rerender } = renderHook(
        ({ data }) =>
          useAutosave({
            data,
            onSave,
            onError,
            debounceMs: 100,
          }),
        { initialProps: { data: 'initial' } }
      )

      rerender({ data: 'updated' })

      await act(async () => {
        jest.advanceTimersByTime(100)
      })

      await waitFor(() => {
        expect(onError).toHaveBeenCalledWith(error)
      })
    })
  })

  // ============================================================================
  // MANUAL SAVE
  // ============================================================================

  describe('manual save', () => {
    it('should provide save function for manual trigger', async () => {
      const onSave = jest.fn().mockResolvedValue(undefined)
      const { result, rerender } = renderHook(
        ({ data }) =>
          useAutosave({
            data,
            onSave,
            debounceMs: 10000, // Long debounce
          }),
        { initialProps: { data: 'initial' } }
      )

      rerender({ data: 'updated' })

      // Trigger manual save
      await act(async () => {
        await result.current.save()
      })

      expect(onSave).toHaveBeenCalledWith('updated')
    })
  })

  // ============================================================================
  // RESET
  // ============================================================================

  describe('reset', () => {
    it('should reset status to idle', async () => {
      const error = new Error('Save failed')
      const onSave = jest.fn().mockRejectedValue(error)

      const { result, rerender } = renderHook(
        ({ data }) =>
          useAutosave({
            data,
            onSave,
            debounceMs: 100,
          }),
        { initialProps: { data: 'initial' } }
      )

      rerender({ data: 'updated' })

      await act(async () => {
        jest.advanceTimersByTime(100)
      })

      await waitFor(() => {
        expect(result.current.status).toBe('error')
      })

      act(() => {
        result.current.reset()
      })

      expect(result.current.status).toBe('idle')
      expect(result.current.error).toBeNull()
    })
  })

  // ============================================================================
  // COMPLEX DATA
  // ============================================================================

  describe('complex data types', () => {
    it('should handle object data with deep comparison', async () => {
      const onSave = jest.fn().mockResolvedValue(undefined)
      const { rerender } = renderHook(
        ({ data }) =>
          useAutosave({
            data,
            onSave,
            debounceMs: 100,
          }),
        { initialProps: { data: { name: 'test', value: 1 } } }
      )

      // Change object
      rerender({ data: { name: 'test', value: 2 } })

      await act(async () => {
        jest.advanceTimersByTime(100)
      })

      expect(onSave).toHaveBeenCalledWith({ name: 'test', value: 2 })
    })

    it('should not save if object content is same', async () => {
      const onSave = jest.fn().mockResolvedValue(undefined)
      const { rerender } = renderHook(
        ({ data }) =>
          useAutosave({
            data,
            onSave,
            debounceMs: 100,
          }),
        { initialProps: { data: { name: 'test' } } }
      )

      // "Change" to equivalent object
      rerender({ data: { name: 'test' } })

      await act(async () => {
        jest.advanceTimersByTime(200)
      })

      expect(onSave).not.toHaveBeenCalled()
    })
  })
})
