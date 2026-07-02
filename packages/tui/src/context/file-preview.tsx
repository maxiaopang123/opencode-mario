import { createContext, createSignal, useContext, type JSX } from "solid-js"

type FilePreviewContext = {
  selectedFile: () => string | null
  setSelectedFile: (path: string | null) => void
}

const FilePreviewContext = createContext<FilePreviewContext>()

export function FilePreviewProvider(props: { children: JSX.Element }) {
  const [selectedFile, setSelectedFile] = createSignal<string | null>(null)
  return (
    <FilePreviewContext.Provider value={{ selectedFile, setSelectedFile }}>
      {props.children}
    </FilePreviewContext.Provider>
  )
}

export function useFilePreview() {
  const ctx = useContext(FilePreviewContext)
  if (!ctx) throw new Error("useFilePreview must be used within FilePreviewProvider")
  return ctx
}
