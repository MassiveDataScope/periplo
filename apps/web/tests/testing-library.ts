import { configure } from "@testing-library/react";

// findBy* and waitFor give up after this many milliseconds.
configure({ asyncUtilTimeout: 5000 });
