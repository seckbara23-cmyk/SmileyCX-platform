'use client'

import { useState, useRef } from 'react'
import { Upload, Loader2, ImageIcon, CheckCircle2 } from 'lucide-react'
import Image from 'next/image'

interface Props {
  name: string         // hidden input name (cover_url)
  initialUrl: string | null
}

export default function CourseCoverUpload({ name, initialUrl }: Props) {
  const [url, setUrl] = useState<string>(initialUrl ?? '')
  const [status, setStatus] = useState<'idle' | 'uploading' | 'done' | 'error'>('idle')
  const [progress, setProgress] = useState(0)
  const [errorMsg, setErrorMsg] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)

  async function handleChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) return

    setStatus('uploading')
    setProgress(0)
    setErrorMsg('')

    try {
      const res = await fetch('/api/admin/upload-url', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ filename: file.name, contentType: file.type, folder: 'cover' }),
      })
      if (!res.ok) {
        const { error } = await res.json()
        throw new Error(error ?? 'Erreur serveur')
      }
      const { signedUrl, publicUrl } = await res.json()

      await new Promise<void>((resolve, reject) => {
        const xhr = new XMLHttpRequest()
        xhr.upload.onprogress = ev =>
          setProgress(Math.round((ev.loaded / ev.total) * 100))
        xhr.onload = () => (xhr.status < 300 ? resolve() : reject(new Error(`HTTP ${xhr.status}`)))
        xhr.onerror = () => reject(new Error('Upload échoué'))
        xhr.open('PUT', signedUrl)
        xhr.setRequestHeader('Content-Type', file.type)
        xhr.send(file)
      })

      setUrl(publicUrl)
      setStatus('done')
    } catch (err) {
      setStatus('error')
      setErrorMsg(err instanceof Error ? err.message : 'Erreur inconnue')
    }
  }

  return (
    <div className="flex flex-col gap-3">
      {/* Preview */}
      {url ? (
        <div className="relative w-full aspect-video rounded-xl overflow-hidden border border-gray-200 bg-gray-50">
          <Image
            src={url}
            alt="Couverture"
            fill
            className="object-cover"
            unoptimized
          />
        </div>
      ) : (
        <div className="w-full aspect-video rounded-xl border-2 border-dashed border-gray-200 bg-gray-50 flex flex-col items-center justify-center gap-2 text-gray-300">
          <ImageIcon className="w-10 h-10" />
          <span className="text-xs">Aucune image de couverture</span>
        </div>
      )}

      {/* Progress */}
      {status === 'uploading' && (
        <div className="flex flex-col gap-1">
          <div className="h-1.5 rounded-full bg-gray-100 overflow-hidden">
            <div className="h-full bg-primary transition-all duration-150" style={{ width: `${progress}%` }} />
          </div>
          <span className="text-xs text-gray-400">{progress}% — envoi en cours…</span>
        </div>
      )}
      {status === 'done' && (
        <p className="flex items-center gap-1.5 text-xs text-green-600 font-medium">
          <CheckCircle2 className="w-3.5 h-3.5" /> Image uploadée avec succès
        </p>
      )}
      {status === 'error' && (
        <p className="text-xs text-red-500">{errorMsg}</p>
      )}

      {/* Upload button */}
      <button
        type="button"
        onClick={() => inputRef.current?.click()}
        disabled={status === 'uploading'}
        className="inline-flex items-center gap-2 px-3.5 py-2.5 rounded-xl border border-gray-200 text-sm font-semibold text-gray-600 hover:bg-gray-50 disabled:opacity-50 transition-colors w-fit"
      >
        {status === 'uploading'
          ? <Loader2 className="w-4 h-4 animate-spin" />
          : <Upload className="w-4 h-4" />}
        {url ? 'Changer l\'image' : 'Choisir une image'}
      </button>
      <input
        ref={inputRef}
        type="file"
        accept="image/jpeg,image/png,image/webp"
        className="hidden"
        onChange={handleChange}
      />

      {/* Hidden field submitted with the parent form */}
      <input type="hidden" name={name} value={url} />
    </div>
  )
}
