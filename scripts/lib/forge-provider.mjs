export class ForgeProvider {
  async version() {
    throw new Error("ForgeProvider.version must be implemented.");
  }

  async repository(_options) {
    throw new Error("ForgeProvider.repository must be implemented.");
  }

  async listChangeRequests(_options) {
    throw new Error("ForgeProvider.listChangeRequests must be implemented.");
  }

  async changeRequest(_options) {
    throw new Error("ForgeProvider.changeRequest must be implemented.");
  }

  async listReviews(_options) {
    throw new Error("ForgeProvider.listReviews must be implemented.");
  }

  async listReviewComments(_options) {
    throw new Error("ForgeProvider.listReviewComments must be implemented.");
  }

  async listIssueComments(_options) {
    throw new Error("ForgeProvider.listIssueComments must be implemented.");
  }

  async commitStatus(_options) {
    throw new Error("ForgeProvider.commitStatus must be implemented.");
  }
}
