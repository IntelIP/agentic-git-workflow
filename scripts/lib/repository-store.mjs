export class RepositoryStore {
  /** @param {string} revision @returns {Promise<string>} */
  async resolveRef(_revision) {
    throw new Error("RepositoryStore.resolveRef must be implemented.");
  }

  /** @param {string} revision @returns {Promise<string[]>} */
  async listFiles(_revision) {
    throw new Error("RepositoryStore.listFiles must be implemented.");
  }

  /** @param {string} baseRevision @param {string} headRevision */
  async getDiff(_baseRevision, _headRevision) {
    throw new Error("RepositoryStore.getDiff must be implemented.");
  }

  /** @param {string} branch */
  async validateBranch(_branch) {
    throw new Error("RepositoryStore.validateBranch must be implemented.");
  }

  /** @param {string} ref */
  async hasRef(_ref) {
    throw new Error("RepositoryStore.hasRef must be implemented.");
  }

  /** @param {{path: string, branch: string, startPoint: string}} options */
  async createWorkspace(_options) {
    throw new Error("RepositoryStore.createWorkspace must be implemented.");
  }

  /** @param {{path: string, force?: boolean}} options */
  async removeWorkspace(_options) {
    throw new Error("RepositoryStore.removeWorkspace must be implemented.");
  }

  /** @param {string} revision @param {{notesRef?: string}} options */
  async readNote(_revision, _options = {}) {
    throw new Error("RepositoryStore.readNote must be implemented.");
  }

  /** @param {string} revision @param {{notesRef?: string, note: string}} options */
  async writeNote(_revision, _options) {
    throw new Error("RepositoryStore.writeNote must be implemented.");
  }

  /** @param {string} ancestorRevision @param {string} descendantRevision */
  async isAncestor(_ancestorRevision, _descendantRevision) {
    throw new Error("RepositoryStore.isAncestor must be implemented.");
  }

  /** @param {{base: string, head: string}} options */
  async previewMerge(_options) {
    throw new Error("RepositoryStore.previewMerge must be implemented.");
  }

  /** @param {{ref: string, newRevision: string, expectedOldCommit?: string | null}} options */
  async compareAndSwapRef(_options) {
    throw new Error("RepositoryStore.compareAndSwapRef must be implemented.");
  }

  /** @param {{ref: string, newRevision: string, expectedOldCommit: string}} options */
  async fastForwardRef(_options) {
    throw new Error("RepositoryStore.fastForwardRef must be implemented.");
  }
}
