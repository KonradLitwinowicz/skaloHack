'use client'

import * as React from 'react'
import { Loader2, X } from 'lucide-react'
import { SearchInput } from '@open-mercato/ui/primitives/search-input'
import { IconButton } from '@open-mercato/ui/primitives/icon-button'
import type { LookupSelectItem } from '@open-mercato/ui/backend/inputs'
import { useT } from '@open-mercato/shared/lib/i18n/context'

const SEARCH_DEBOUNCE_MS = 200

export type QuickPickerProps = {
  fetchItems: (query: string) => Promise<LookupSelectItem[]>
  onPick: (item: LookupSelectItem) => void
  placeholder: string
  /** Shown as a chip in place of the input once something is picked; omit for an "add" picker. */
  selected?: LookupSelectItem | null
  onClear?: () => void
  /** Keep the query after a pick (an "add" picker clears it and stays focused for the next one). */
  keepQueryOnPick?: boolean
  minQuery?: number
  autoFocus?: boolean
  disabled?: boolean
  inputId?: string
  hint?: React.ReactNode
  className?: string
}

/**
 * A search box that turns into a list as you type and picks on Enter — the "type, Enter, next"
 * rhythm a desk needs. `LookupSelect` renders every hit as a card under the input and needs a
 * click per pick, which is right for a form field and wrong for adding ten lines in a row.
 */
export function QuickPicker({
  fetchItems,
  onPick,
  placeholder,
  selected,
  onClear,
  keepQueryOnPick = false,
  minQuery = 1,
  autoFocus = false,
  disabled = false,
  inputId,
  hint,
  className,
}: QuickPickerProps) {
  const t = useT()
  const [query, setQuery] = React.useState('')
  const [items, setItems] = React.useState<LookupSelectItem[]>([])
  const [loading, setLoading] = React.useState(false)
  const [open, setOpen] = React.useState(false)
  const [activeIndex, setActiveIndex] = React.useState(0)
  const inputRef = React.useRef<HTMLInputElement>(null)
  const requestRef = React.useRef(0)
  const listboxId = React.useId()

  const shouldSearch = query.trim().length >= minQuery

  React.useEffect(() => {
    if (!shouldSearch || disabled) {
      setItems([])
      setLoading(false)
      return
    }
    const requestId = requestRef.current + 1
    requestRef.current = requestId
    setLoading(true)
    const timer = setTimeout(() => {
      fetchItems(query.trim())
        .then((result) => {
          if (requestRef.current !== requestId) return
          setItems(result)
          setActiveIndex(0)
        })
        .catch(() => {
          if (requestRef.current !== requestId) return
          setItems([])
        })
        .finally(() => {
          if (requestRef.current === requestId) setLoading(false)
        })
    }, SEARCH_DEBOUNCE_MS)
    return () => clearTimeout(timer)
  }, [disabled, fetchItems, query, shouldSearch])

  const pick = React.useCallback(
    (item: LookupSelectItem) => {
      if (item.disabled) return
      onPick(item)
      if (!keepQueryOnPick) {
        setQuery('')
        setItems([])
      }
      setOpen(!keepQueryOnPick)
      inputRef.current?.focus()
    },
    [keepQueryOnPick, onPick],
  )

  const onKeyDown = React.useCallback(
    (event: React.KeyboardEvent<HTMLInputElement>) => {
      if (event.key === 'ArrowDown') {
        event.preventDefault()
        setOpen(true)
        setActiveIndex((index) => (items.length ? (index + 1) % items.length : 0))
        return
      }
      if (event.key === 'ArrowUp') {
        event.preventDefault()
        setActiveIndex((index) => (items.length ? (index - 1 + items.length) % items.length : 0))
        return
      }
      if (event.key === 'Enter') {
        const item = items[activeIndex] ?? items[0]
        if (!item || !open) return
        event.preventDefault()
        pick(item)
        return
      }
      if (event.key === 'Escape') {
        if (query.length === 0) return
        event.preventDefault()
        event.stopPropagation()
        setQuery('')
        setItems([])
      }
    },
    [activeIndex, items, open, pick, query.length],
  )

  if (selected) {
    return (
      <div className={className}>
        <div className="flex h-10 items-center gap-2 rounded-lg border border-input bg-background pl-3 pr-1 text-sm">
          <span className="min-w-0 flex-1 truncate">
            <span className="font-medium">{selected.title}</span>
            {selected.subtitle ? <span className="ml-2 text-muted-foreground">{selected.subtitle}</span> : null}
          </span>
          {onClear ? (
            <IconButton
              type="button"
              variant="ghost"
              size="sm"
              aria-label={t('ui.lookupSelect.clearSelection', 'Clear selection')}
              onClick={onClear}
              disabled={disabled}
            >
              <X className="h-4 w-4" />
            </IconButton>
          ) : null}
        </div>
        {hint ? <div className="mt-1 text-xs text-muted-foreground">{hint}</div> : null}
      </div>
    )
  }

  const listVisible = open && shouldSearch && !disabled

  return (
    <div className={className ? `relative ${className}` : 'relative'}>
      <SearchInput
        ref={inputRef}
        id={inputId}
        value={query}
        onChange={(next) => {
          setQuery(next)
          setOpen(true)
        }}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        onKeyDown={onKeyDown}
        placeholder={placeholder}
        autoFocus={autoFocus}
        disabled={disabled}
        autoComplete="off"
        role="combobox"
        aria-expanded={listVisible}
        aria-controls={listboxId}
        aria-autocomplete="list"
      />
      {hint ? <div className="mt-1 text-xs text-muted-foreground">{hint}</div> : null}
      {listVisible ? (
        <div
          id={listboxId}
          role="listbox"
          className="absolute left-0 right-0 top-full z-50 mt-1 max-h-72 overflow-y-auto rounded-md border border-border bg-popover p-1 text-popover-foreground shadow-md"
        >
          {loading && items.length === 0 ? (
            <div className="flex items-center gap-2 px-3 py-2 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" />
              {t('ui.lookupSelect.searching', 'Searching…')}
            </div>
          ) : null}
          {!loading && items.length === 0 ? (
            <div className="px-3 py-2 text-sm text-muted-foreground">{t('ui.lookupSelect.noResults', 'No results')}</div>
          ) : null}
          {items.map((item, index) => {
            const active = index === activeIndex
            return (
              <div
                key={item.id}
                role="option"
                aria-selected={active}
                aria-disabled={item.disabled ? true : undefined}
                className={`flex cursor-pointer items-center justify-between gap-3 rounded-sm px-3 py-2 text-sm ${
                  active ? 'bg-accent text-accent-foreground' : 'hover:bg-accent/60'
                } ${item.disabled ? 'cursor-not-allowed opacity-60' : ''}`}
                onMouseDown={(event) => {
                  event.preventDefault()
                  pick(item)
                }}
                onMouseEnter={() => setActiveIndex(index)}
              >
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-medium">{item.title}</span>
                  {item.subtitle ? <span className="block truncate text-xs text-muted-foreground">{item.subtitle}</span> : null}
                </span>
                {item.rightLabel ? (
                  <span className="shrink-0 text-xs tabular-nums text-muted-foreground">{item.rightLabel}</span>
                ) : null}
              </div>
            )
          })}
        </div>
      ) : null}
    </div>
  )
}

export default QuickPicker
