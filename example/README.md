# Use case of this devops tool

[!] All of these files are examples, you can modify them to fit your needs.     

You have to copy the `.gitmodules` file and the `deployment` folder to your project root's directory.

# CI

The CI configurations inside the `ci` folder are working examples reusing the ci configurations from this repository.   
*Note: For the GitHub workflow, you'll have to fork this repository and replace the `uses` url by yours.*

## Secrets

You can use secrets variables from GitHub or GitLab inside your `compose-deploy.yml` file like an environment variable.