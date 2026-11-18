/// <reference types="cypress" />
/// <reference types="../../cypress/support" />

// The example ships a local cursor-aware mock API (25 posts, page size 5,
// cursors in the `x-next-cursor` / `x-prev-cursor` response headers).
describe("table-antd-cursor-pagination", () => {
  beforeEach(() => {
    cy.visit("/");
  });

  const firstTitle = () => cy.get(".ant-table-row").first();

  it("shows an antd table with the first page of posts", () => {
    cy.get(".ant-table").should("be.visible");
    cy.get(".ant-table-row").should("have.length", 5);
    firstTitle().should("contain", "Post 1");
  });

  it("disables prev on the first page and enables next", () => {
    cy.get(".ant-table-row").should("have.length", 5);
    cy.get(".ant-pagination-prev").should(
      "have.class",
      "ant-pagination-disabled",
    );
    cy.get(".ant-pagination-next").should(
      "not.have.class",
      "ant-pagination-disabled",
    );
  });

  it("loads the next page through the cursor when next is clicked", () => {
    cy.intercept("GET", "**/posts*cursor=*").as("nextPage");
    cy.get(".ant-table-row").should("have.length", 5);
    cy.get(".ant-pagination-next").click();
    cy.wait("@nextPage");
    firstTitle().should("contain", "Post 6");
    cy.get(".ant-pagination-prev").should(
      "not.have.class",
      "ant-pagination-disabled",
    );
  });

  it("returns to the previous page when prev is clicked", () => {
    cy.get(".ant-table-row").should("have.length", 5);
    cy.get(".ant-pagination-next").click();
    firstTitle().should("contain", "Post 6");
    cy.get(".ant-pagination-prev").click();
    firstTitle().should("contain", "Post 1");
    cy.get(".ant-pagination-prev").should(
      "have.class",
      "ant-pagination-disabled",
    );
  });

  it("labels the list so the cursor mode is recognisable", () => {
    cy.get(".ant-table-row").should("have.length", 5);
    cy.contains("Posts (cursor pagination)").should("be.visible");
  });

  it("pin: shows prev/next only, without page-number items", () => {
    cy.get(".ant-table-row").should("have.length", 5);
    cy.get(".ant-pagination-item").should("not.exist");
  });

  it("pin: prev from the third page returns to the second page", () => {
    cy.get(".ant-table-row").should("have.length", 5);
    cy.get(".ant-pagination-next").click();
    firstTitle().should("contain", "Post 6");
    cy.get(".ant-pagination-next").click();
    firstTitle().should("contain", "Post 11");
    cy.get(".ant-pagination-prev").click();
    firstTitle().should("contain", "Post 6");
  });

  it("disables next on the last page", () => {
    cy.get(".ant-table-row").should("have.length", 5);
    for (let page = 2; page <= 5; page++) {
      cy.get(".ant-pagination-next").click();
      firstTitle().should("contain", `Post ${(page - 1) * 5 + 1}`);
    }
    cy.get(".ant-pagination-next").should(
      "have.class",
      "ant-pagination-disabled",
    );
  });
});
