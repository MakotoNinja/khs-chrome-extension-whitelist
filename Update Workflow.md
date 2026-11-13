### Workflow for Future Code Updates:



#### When you make changes to your extension code in the future:

Bump Version: Open manifest.json in your source folder and increment the version number i.e. "version": "1.0.3".

Pack with Pem: In chrome://extensions, click Pack extension, select your code folder, and select extension.pem in Private key file.



Upload New Package:
 • Move extension.crx to "netlify-deploy" folder
 • Update version number in file "netlify-deploy/update.xml" to match manifest.json version number
 • Upload netlify-deploy folder to netlify project: majestic-salmiakki-3ebd8d
   https://app.netlify.com/projects/majestic-salmiakki-3ebd8d/overview



Update Google Admin:
 • Devices > Chrome ? Apps \& Extensions > User \& Browsers
 • Choose Student root OU
 • Find app by searching ID: kcafjbecimoheboaemiegicniiknangd
 • Modify "Installation URL" to reflect new version number (circumvent aggressive caching)
   i.e. https://majestic-salmiakki-3ebd8d.netlify.app/update.xml\*\*?v=1.0.3\*\*



Chromebooks should update whenever users log in.

