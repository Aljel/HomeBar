import { lazy } from "react";
import { Route, Routes } from "react-router";
import { Layout } from "./components/Layout";

const Home = lazy(() => import("./routes/Home"));
const Recipes = lazy(() => import("./routes/Recipes"));
const RecipePage = lazy(() => import("./routes/RecipePage"));
const RecipeEditor = lazy(() => import("./routes/RecipeEditor"));
const Discover = lazy(() => import("./routes/Discover"));
const GuestMenu = lazy(() => import("./routes/GuestMenu"));
const Bar = lazy(() => import("./routes/Bar"));
const Pantry = lazy(() => import("./routes/Pantry"));
const About = lazy(() => import("./routes/About"));
const NotFound = lazy(() => import("./routes/NotFound"));

export function App() {
  return (
    <Layout>
      <Routes>
        <Route path="/" element={<Home />} />
        <Route path="/recipes" element={<Recipes />} />
        <Route path="/recipes/new" element={<RecipeEditor />} />
        <Route path="/recipes/:id" element={<RecipePage />} />
        <Route path="/recipes/:id/edit" element={<RecipeEditor />} />
        <Route path="/discover" element={<Discover />} />
        <Route path="/menu" element={<GuestMenu />} />
        <Route path="/bar" element={<Bar />} />
        <Route path="/pantry" element={<Pantry />} />
        <Route path="/about" element={<About />} />
        <Route path="*" element={<NotFound />} />
      </Routes>
    </Layout>
  );
}
