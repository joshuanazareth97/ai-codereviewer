import gitDiffParser from "gitdiff-parser";

let gitDiffText = "";

process.stdin.on("readable", () => {
  let chunk;
  while (null !== (chunk = process.stdin.read())) {
    gitDiffText += chunk;
  }
});

function parseDiff() {
  const files = gitDiffParser.parse(gitDiffText);

  files.forEach((file) => {
    console.log(`+++++++++++ ${file.newPath} ++++++++++++`);
    file.hunks.forEach((hunk) => {
      let block = "";
      block += hunk.changes
        .filter((change) => change.type === "insert")
        .map((change) => change.content)
        .join("\n");
      console.log(block);
      console.log("");
    });
    console.log("\n");
  });
}

process.stdin.on("end", parseDiff);
