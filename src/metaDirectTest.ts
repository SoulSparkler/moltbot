export async function runMetaDirectTest() {
  const token = process.env.META_ACCESS_TOKEN;
  const pageId = process.env.META_PAGE_ID;

  if (!token || !pageId) {
    console.log("META TEST: Missing env vars");
    return;
  }

  console.log("META TEST: Running page access check");

  try {
    const response = await fetch(`https://graph.facebook.com/v18.0/${pageId}?fields=id,name`, {
      headers: {
        Authorization: `Bearer ${token}`,
      },
    });

    const text = await response.text();

    console.log("META TEST STATUS:", response.status);
    console.log("META TEST RESPONSE:", text);
  } catch (err) {
    console.error("META TEST ERROR:", err);
  }
}
