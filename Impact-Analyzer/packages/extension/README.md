# Impact Guard for VS Code

**Impact Guard** is an enterprise-grade, real-time, line-level impact analyzer for Angular applications. It builds a localized dependency graph of your Angular modules, components, services, and routes to give you instant insight into the ripple effects of code modifications.

---

## Key Features

- **🛡️ Real-Time Risk Analysis**: Instantly calculates risk levels (`LOW`, `MEDIUM`, `HIGH`, `CRITICAL`) when editing symbols.
- **👁️ Hover Tooltips**: Hover over components, services, or routes to view upstream dependencies and their downstream usage counts.
- **🔍 CodeLens Indicators**: Displays inline indicators showing the downstream impact count directly above class definitions.
- **📁 Sidebar View Panel**: Explorable sidebar panel listing all downstream components, modules, and routes affected by the active selection.
- **📊 Export Reports**: Generate and export comprehensive Markdown or JSON impact reports for code reviews.
- **⚠️ Diagnostic Warnings**: Surfaces high-impact risk notifications directly in your editor's problems view.

---

## How to Use

1. **Activate**: The extension activates automatically when you open an Angular project. You will see `Impact Guard: Indexing...` and then `Impact Guard: Active` in the bottom status bar.
2. **Analysis**:
   - Hover over component classes, services, or inputs/outputs.
   - Click the CodeLens indicators above classes to trigger an immediate impact tree generation.
   - Check the **Impact Guard** sidebar tab in the Activity Bar to explore the complete tree structure.
3. **Commands**:
   - `Impact Guard: Analyze Current Symbol` - Runs analysis on the symbol under your cursor.
   - `Impact Guard: Show Dependency Graph` - Shows statistics on the total graph size.
   - `Impact Guard: Analyze Workspace` - Warns you of critical/high-risk nodes in the codebase.
   - `Impact Guard: Export Report` - Saves the current impact report as a Markdown or JSON file.

---

## Requirements

- VS Code version `1.80.0` or higher.
- A workspace containing an Angular application.
