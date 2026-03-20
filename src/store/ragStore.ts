import { create } from 'zustand';
import {
  ragCreateCollection,
  ragListCollections,
  ragDeleteCollection,
  ragGetCollectionStats,
  ragAddDocument,
  ragRemoveDocument,
  ragListDocuments,
  ragGetPendingEmbeddings,
  ragStoreEmbeddings,
  ragSearch,
  ragReindexCollection,
  ragGetDocumentContent,
  ragUpdateDocument,
  ragCreateBlankDocument,
  ragOpenDocumentExternal,
} from '@/lib/api';
import type {
  RagCollection,
  RagDocument,
  RagCollectionStats,
  RagPendingEmbedding,
  RagSearchResult,
} from '@/types';

// ═══════════════════════════════════════════════════════════════════════════
// Store Interface
// ═══════════════════════════════════════════════════════════════════════════

type RagStoreState = {
  collections: RagCollection[];
  selectedCollectionId: string | null;
  documents: RagDocument[];
  stats: RagCollectionStats | null;
  statsStale: boolean;
  searchResults: RagSearchResult[];
  isLoading: boolean;
  error: string | null;
  editingDocId: string | null;
  editFilePath: string | null;

  // Actions
  loadCollections: (scopeFilter?: string) => Promise<void>;
  createCollection: (name: string, scope: 'global' | { connectionId: string }) => Promise<RagCollection>;
  deleteCollection: (collectionId: string) => Promise<void>;
  selectCollection: (collectionId: string | null) => Promise<void>;
  addDocument: (collectionId: string, title: string, content: string, format: string, sourcePath?: string) => Promise<RagDocument>;
  removeDocument: (docId: string) => Promise<void>;
  search: (query: string, collectionIds: string[], queryVector?: number[], topK?: number) => Promise<RagSearchResult[]>;
  getPendingEmbeddings: (collectionId: string, limit?: number) => Promise<RagPendingEmbedding[]>;
  storeEmbeddings: (embeddings: Array<{ chunkId: string; vector: number[] }>, modelName: string) => Promise<number>;
  reindexCollection: (collectionId: string) => Promise<number>;
  createBlankDocument: (collectionId: string, title: string, format: string) => Promise<RagDocument>;
  openDocumentExternal: (docId: string) => Promise<string>;
  syncExternalEdits: () => Promise<{ updated: boolean; docId: string } | null>;
  clearEditing: () => void;
  clearError: () => void;
};

// ═══════════════════════════════════════════════════════════════════════════
// Store Implementation
// ═══════════════════════════════════════════════════════════════════════════

export const useRagStore = create<RagStoreState>()((set, get) => ({
  collections: [],
  selectedCollectionId: null,
  documents: [],
  stats: null,
  statsStale: false,
  searchResults: [],
  isLoading: false,
  error: null,
  editingDocId: null,
  editFilePath: null,

  loadCollections: async (scopeFilter?: string) => {
    set({ isLoading: true, error: null });
    try {
      const collections = await ragListCollections(scopeFilter);
      set({ collections, isLoading: false });
    } catch (e) {
      set({ error: String(e), isLoading: false });
    }
  },

  createCollection: async (name, scope) => {
    const scopeDto = scope === 'global'
      ? 'Global' as const
      : { Connection: { connection_id: scope.connectionId } };
    const collection = await ragCreateCollection(name, scopeDto);
    set((s) => ({ collections: [...s.collections, collection] }));
    return collection;
  },

  deleteCollection: async (collectionId) => {
    await ragDeleteCollection(collectionId);
    set((s) => ({
      collections: s.collections.filter((c) => c.id !== collectionId),
      selectedCollectionId: s.selectedCollectionId === collectionId ? null : s.selectedCollectionId,
      documents: s.selectedCollectionId === collectionId ? [] : s.documents,
      stats: s.selectedCollectionId === collectionId ? null : s.stats,
    }));
  },

  selectCollection: async (collectionId) => {
    set({ selectedCollectionId: collectionId, documents: [], stats: null });
    if (!collectionId) return;
    try {
      set({ isLoading: true });
      const [documents, stats] = await Promise.all([
        ragListDocuments(collectionId),
        ragGetCollectionStats(collectionId),
      ]);
      set({ documents, stats, isLoading: false, statsStale: false });
    } catch (e) {
      set({ error: String(e), isLoading: false, statsStale: true });
    }
  },

  addDocument: async (collectionId, title, content, format, sourcePath) => {
    const doc = await ragAddDocument({ collectionId, title, content, format, sourcePath });
    set((s) => ({ documents: [...s.documents, doc] }));
    // Refresh stats
    try {
      const stats = await ragGetCollectionStats(collectionId);
      set({ stats, statsStale: false });
    } catch {
      set({ statsStale: true });
    }
    return doc;
  },

  removeDocument: async (docId) => {
    // Clean up temp file if this doc is currently being edited
    const { editingDocId, editFilePath } = get();
    if (editingDocId === docId && editFilePath) {
      try {
        const { remove } = await import('@tauri-apps/plugin-fs');
        await remove(editFilePath);
      } catch { /* best-effort */ }
      set({ editingDocId: null, editFilePath: null });
    }
    await ragRemoveDocument(docId);
    set((s) => ({
      documents: s.documents.filter((d) => d.id !== docId),
    }));
    // Refresh stats
    const { selectedCollectionId } = get();
    if (selectedCollectionId) {
      try {
        const stats = await ragGetCollectionStats(selectedCollectionId);
        set({ stats, statsStale: false });
      } catch {
        set({ statsStale: true });
      }
    }
  },

  search: async (query, collectionIds, queryVector, topK) => {
    const results = await ragSearch({ query, collectionIds, queryVector, topK });
    set({ searchResults: results });
    return results;
  },

  getPendingEmbeddings: (collectionId, limit) =>
    ragGetPendingEmbeddings(collectionId, limit),

  storeEmbeddings: (embeddings, modelName) =>
    ragStoreEmbeddings(embeddings, modelName),

  reindexCollection: (collectionId) =>
    ragReindexCollection(collectionId),

  createBlankDocument: async (collectionId, title, format) => {
    const doc = await ragCreateBlankDocument({ collectionId, title, format });
    set((s) => ({ documents: [...s.documents, doc] }));
    try {
      const stats = await ragGetCollectionStats(collectionId);
      set({ stats, statsStale: false });
    } catch {
      set({ statsStale: true });
    }
    return doc;
  },

  openDocumentExternal: async (docId) => {
    const filePath = await ragOpenDocumentExternal(docId);
    set({ editingDocId: docId, editFilePath: filePath });
    return filePath;
  },

  syncExternalEdits: async () => {
    const { editingDocId, editFilePath, selectedCollectionId } = get();
    if (!editingDocId || !editFilePath) return null;

    const { readTextFile, remove } = await import('@tauri-apps/plugin-fs');
    const fileContent = await readTextFile(editFilePath);
    const storedContent = await ragGetDocumentContent(editingDocId);

    if (fileContent === storedContent) {
      // Clean up temp file
      try { await remove(editFilePath); } catch { /* best-effort */ }
      set({ editingDocId: null, editFilePath: null });
      return { updated: false, docId: editingDocId };
    }

    const updatedDoc = await ragUpdateDocument(editingDocId, fileContent);
    // Clean up temp file after successful sync
    try { await remove(editFilePath); } catch { /* best-effort */ }
    set((s) => ({
      documents: s.documents.map((d) => d.id === updatedDoc.id ? updatedDoc : d),
      editingDocId: null,
      editFilePath: null,
    }));

    // Refresh stats
    if (selectedCollectionId) {
      try {
        const stats = await ragGetCollectionStats(selectedCollectionId);
        set({ stats, statsStale: false });
      } catch {
        set({ statsStale: true });
      }
    }

    return { updated: true, docId: editingDocId };
  },

  clearEditing: () => set({ editingDocId: null, editFilePath: null }),

  clearError: () => set({ error: null }),
}));
