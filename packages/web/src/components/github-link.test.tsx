// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { GitHubLink } from "./github-link";

afterEach(cleanup);

describe("GitHubLink", () => {
  it("opens the public repository in a new tab", () => {
    render(<GitHubLink />);
    const link = screen.getByRole("link", { name: "GitHub" });

    expect(link.getAttribute("href")).toBe("https://github.com/danieliyahu1/kticket");
    expect(link.getAttribute("target")).toBe("_blank");
    expect(link.getAttribute("rel")).toBe("noopener noreferrer");
  });

  it("keeps the icon decorative", () => {
    render(<GitHubLink />);
    const icon = screen.getByRole("link", { name: "GitHub" }).querySelector("svg");

    expect(icon?.getAttribute("aria-hidden")).toBe("true");
  });
});
