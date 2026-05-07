'use client'

import {
  DndContext,
  DragEndEvent,
  PointerSensor,
  TouchSensor,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
} from '@dnd-kit/core'
import { CSS } from '@dnd-kit/utilities'
import { GripVertical } from 'lucide-react'

export interface DragMatchOptions {
  categories: { id: string; label: string }[]
  items: { id: string; label: string }[]
}

interface Props {
  questionId: string
  options: DragMatchOptions
  placements: Record<string, string>
  onPlacementsChange: (_placements: Record<string, string>) => void
  submitted: boolean
  correctPlacements?: Record<string, string>
  explanation?: string | null
}

// ── Draggable item chip ──────────────────────────────────────────────────────

function DraggableItem({
  id,
  label,
  disabled,
  correct,
  wrong,
}: {
  id: string
  label: string
  disabled: boolean
  correct?: boolean
  wrong?: boolean
}) {
  const { attributes, listeners, setNodeRef, transform, isDragging } =
    useDraggable({ id, disabled })

  const style = {
    transform: CSS.Translate.toString(transform),
    opacity: isDragging ? 0.5 : 1,
  }

  const borderColor = correct
    ? 'border-green-500 bg-green-500/15 text-green-300'
    : wrong
    ? 'border-red-500 bg-red-500/15 text-red-300'
    : 'border-white/20 bg-white/10 text-white'

  return (
    <div
      ref={setNodeRef}
      style={style}
      {...attributes}
      {...listeners}
      className={`relative flex items-center gap-1.5 px-3 py-2 rounded-lg border text-sm select-none touch-none transition-colors ${borderColor} ${
        !disabled ? 'cursor-grab active:cursor-grabbing' : 'cursor-default'
      }`}
    >
      {!disabled && (
        <GripVertical className="w-3 h-3 text-white/30 shrink-0" />
      )}
      <span>{label}</span>
      {correct && (
        <span className="ml-1 text-green-400 text-xs font-bold">✓</span>
      )}
      {wrong && (
        <span className="ml-1 text-red-400 text-xs font-bold">✗</span>
      )}
    </div>
  )
}

// ── Category drop zone ────────────────────────────────────────────────────────

function CategoryZone({
  id,
  label,
  items,
  placements,
  disabled,
  submitted,
  correctPlacements,
}: {
  id: string
  label: string
  items: DragMatchOptions['items']
  placements: Record<string, string>
  disabled: boolean
  submitted: boolean
  correctPlacements?: Record<string, string>
}) {
  const { setNodeRef, isOver } = useDroppable({ id })
  const placed = items.filter(item => placements[item.id] === id)

  return (
    <div
      ref={setNodeRef}
      className={`min-w-[140px] flex-1 min-h-[90px] rounded-xl border-2 p-3 transition-colors ${
        isOver
          ? 'border-primary bg-primary/15'
          : 'border-white/20 bg-white/5'
      }`}
    >
      <p className="text-[11px] font-bold text-white/60 uppercase tracking-wide mb-2">
        {label}
      </p>
      <div className="flex flex-col gap-1.5 min-h-[24px]">
        {placed.map(item => {
          const isCorrect = submitted && correctPlacements
            ? correctPlacements[item.id] === id
            : undefined
          const isWrong = submitted && correctPlacements
            ? correctPlacements[item.id] !== id
            : undefined
          return (
            <DraggableItem
              key={item.id}
              id={item.id}
              label={item.label}
              disabled={disabled}
              correct={isCorrect}
              wrong={isWrong}
            />
          )
        })}
      </div>
    </div>
  )
}

// ── Main component ────────────────────────────────────────────────────────────

export default function DragMatchQuestion({
  questionId,
  options,
  placements,
  onPlacementsChange,
  submitted,
  correctPlacements,
  explanation,
}: Props) {
  const sensors = useSensors(
    useSensor(PointerSensor),
    useSensor(TouchSensor, { activationConstraint: { delay: 200, tolerance: 8 } }),
  )

  const poolId = `pool-${questionId}`
  const { setNodeRef: poolRef, isOver: poolIsOver } = useDroppable({ id: poolId })

  const { categories, items } = options
  const unplaced = items.filter(item => !placements[item.id])

  function handleDragEnd(event: DragEndEvent) {
    if (submitted) return
    const { active, over } = event
    if (!over) return
    const itemId = active.id as string
    const targetId = over.id as string
    if (targetId === poolId) {
      const next = { ...placements }
      delete next[itemId]
      onPlacementsChange(next)
    } else {
      onPlacementsChange({ ...placements, [itemId]: targetId })
    }
  }

  return (
    <DndContext sensors={sensors} onDragEnd={handleDragEnd}>
      {/* Instructions */}
      {!submitted && (
        <p className="text-xs text-white/40 mb-3">
          Faites glisser chaque élément dans la catégorie correcte.
        </p>
      )}

      {/* Category drop zones */}
      <div className="flex flex-wrap gap-3 mb-3">
        {categories.map(cat => (
          <CategoryZone
            key={cat.id}
            id={cat.id}
            label={cat.label}
            items={items}
            placements={placements}
            disabled={submitted}
            submitted={submitted}
            correctPlacements={correctPlacements}
          />
        ))}
      </div>

      {/* Items pool */}
      <div
        ref={poolRef}
        className={`rounded-xl border-2 p-3 min-h-[56px] transition-colors ${
          poolIsOver
            ? 'border-white/40 bg-white/5'
            : 'border-white/10 bg-transparent'
        }`}
      >
        <p className="text-[11px] text-white/30 mb-2">Éléments à placer</p>
        <div className="flex flex-wrap gap-2">
          {unplaced.map(item => (
            <DraggableItem
              key={item.id}
              id={item.id}
              label={item.label}
              disabled={submitted}
            />
          ))}
          {unplaced.length === 0 && !submitted && (
            <p className="text-xs text-white/25 italic">
              Tous les éléments ont été placés — faites-les glisser ici pour annuler.
            </p>
          )}
        </div>
      </div>

      {/* Mobile dropdown fallback — shown on small screens alongside drag */}
      {!submitted && (
        <div className="mt-4 space-y-2 sm:hidden">
          <p className="text-[11px] text-white/40">
            Sur mobile, vous pouvez aussi utiliser les menus :
          </p>
          {items.map(item => (
            <div key={item.id} className="flex items-center gap-2">
              <span className="text-xs text-white/70 flex-1 min-w-0 truncate">
                {item.label}
              </span>
              <select
                value={placements[item.id] ?? ''}
                onChange={e => {
                  const catId = e.target.value
                  if (!catId) {
                    const next = { ...placements }
                    delete next[item.id]
                    onPlacementsChange(next)
                  } else {
                    onPlacementsChange({ ...placements, [item.id]: catId })
                  }
                }}
                className="shrink-0 text-xs bg-white/10 border border-white/20 rounded-lg px-2 py-1.5 text-white"
              >
                <option value="">— Choisir —</option>
                {categories.map(cat => (
                  <option key={cat.id} value={cat.id}>
                    {cat.label}
                  </option>
                ))}
              </select>
            </div>
          ))}
        </div>
      )}

      {/* After submission: show correct answer for wrong placements */}
      {submitted && correctPlacements && items.some(item => placements[item.id] !== correctPlacements[item.id]) && (
        <div className="mt-3 p-3 rounded-xl bg-white/5 border border-white/10">
          <p className="text-xs font-semibold text-white/60 mb-2">Placements corrects :</p>
          <div className="space-y-1">
            {items
              .filter(item => placements[item.id] !== correctPlacements[item.id])
              .map(item => {
                const correctCat = categories.find(c => c.id === correctPlacements[item.id])
                return (
                  <p key={item.id} className="text-xs text-white/50">
                    <span className="text-red-400">{item.label}</span>
                    {' → '}
                    <span className="text-green-400">{correctCat?.label ?? '?'}</span>
                  </p>
                )
              })}
          </div>
        </div>
      )}

      {explanation && submitted && (
        <p className="mt-3 text-xs text-white/50 italic">{explanation}</p>
      )}
    </DndContext>
  )
}
