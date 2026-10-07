import { describe, expect, it } from "vitest";
import { bannerOf, isDirectoryListing, showsStackTrace, sqlError } from "./signatures.js";

describe("sqlError", () => {
  it.each([
    ["You have an error in your SQL syntax; check the manual that corresponds to your MySQL server version", "MySQL"],
    ["Unclosed quotation mark after the character string ''.", "SQL Server"],
    ["ORA-01756: quoted string not properly terminated", "Oracle"],
    ['PG::SyntaxError: ERROR:  syntax error at or near "\'"', "PostgreSQL"],
    ["SQLSTATE[42000]: Syntax error or access violation", "PDO"],
    ["SQLite3::SQLException: unrecognized token: \"'\"", "SQLite"],
    ["ActiveRecord::StatementInvalid (PG::UndefinedColumn", "ORM"],
  ])("recognizes %s", (text, engine) => {
    expect(sqlError(`Something went wrong. ${text} at line 3`)).toBe(engine);
  });

  it("does not take ordinary text for an error", () => {
    expect(sqlError("Resultados para o'Neil: nenhum. Sintaxe da busca: use aspas.")).toBeNull();
    expect(sqlError("Como corrigir um erro de sintaxe SQL no seu relatório")).toBeNull();
  });
});

describe("showsStackTrace", () => {
  it.each([
    "Traceback (most recent call last):\n  File \"app.py\", line 3, in <module>",
    "java.lang.NullPointerException\n\tat com.acme.Orders.list(Orders.java:42)",
    "Server Error in '/' Application. Object reference not set",
    "Fatal error: Uncaught Exception in /var/www/html/index.php on line 12",
    "You're seeing this error because you have DEBUG = True in your Django settings file.",
    "TypeError: x is not a function\n    at Object.<anonymous> (/app/server.js:10:5)",
    "ActionController::RoutingError (No route matches [GET] \"/x\")",
  ])("sees one in %#", (text) => expect(showsStackTrace(text)).toBe(true));

  it("does not take a help article or a page about errors for one", () => {
    expect(showsStackTrace("Algo deu errado. Tente novamente em instantes ou fale com o suporte.")).toBe(false);
    expect(showsStackTrace("Aprenda a ler um stack trace e a corrigir exceções em Java")).toBe(false);
  });
});

describe("isDirectoryListing", () => {
  it("recognizes a server index and nothing less", () => {
    expect(isDirectoryListing("Index of /backups\nName Last modified Size\nParent Directory")).toBe(true);
    expect(isDirectoryListing("Index of /\nParent Directory")).toBe(true);
    expect(isDirectoryListing("O índice (Index of contents) do manual")).toBe(false);
  });
});

describe("bannerOf", () => {
  it("is a version the server announces", () => {
    expect(bannerOf({ server: "nginx/1.18.0" })).toBe("Server: nginx/1.18.0");
    expect(bannerOf({ server: "Apache/2.4.41 (Ubuntu)", "x-powered-by": "PHP/7.4.3" })).toBe("Server: Apache/2.4.41 (Ubuntu); X-Powered-By: PHP/7.4.3");
    expect(bannerOf({ "x-powered-by": "Express" })).toBe("X-Powered-By: Express");
  });
  it("is nothing for a server that only says its name", () => {
    expect(bannerOf({ server: "nginx" })).toBeNull();
    expect(bannerOf({})).toBeNull();
  });
});
