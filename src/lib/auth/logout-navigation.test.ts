import { describe, expect, test } from "bun:test";
import { redirectAfterLogout } from "./logout-navigation";

describe("logout navigation", () => {
  test("mengganti halaman aktif dengan Login", () => {
    const destinations: string[] = [];

    redirectAfterLogout({
      replace(url) {
        destinations.push(url);
      },
    });

    expect(destinations).toEqual(["/login"]);
  });
});
