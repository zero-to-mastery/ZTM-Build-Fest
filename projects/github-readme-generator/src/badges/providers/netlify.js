export function netlifyBadge(c) {
  if (
    !/^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/i.test(
      c.siteId || "",
    )
  )
    throw new Error("Enter the Netlify site ID (UUID from project settings).");
  return {
    path: `netlify/${c.siteId}`,
    link: "https://app.netlify.com/",
    alt: "Netlify deployment status",
  };
}
