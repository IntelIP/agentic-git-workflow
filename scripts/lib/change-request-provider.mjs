export class ChangeRequestProvider {
  async repository(_options) {
    throw new Error("ChangeRequestProvider.repository must be implemented.");
  }

  async listChangeRequests(_options) {
    throw new Error("ChangeRequestProvider.listChangeRequests must be implemented.");
  }

  async changeRequest(_options) {
    throw new Error("ChangeRequestProvider.changeRequest must be implemented.");
  }

  async listReviews(_options) {
    throw new Error("ChangeRequestProvider.listReviews must be implemented.");
  }

  async listReviewComments(_options) {
    throw new Error("ChangeRequestProvider.listReviewComments must be implemented.");
  }

  async listIssueComments(_options) {
    throw new Error("ChangeRequestProvider.listIssueComments must be implemented.");
  }

  async commitStatus(_options) {
    throw new Error("ChangeRequestProvider.commitStatus must be implemented.");
  }
}
